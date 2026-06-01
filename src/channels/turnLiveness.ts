/**
 * Channel turn liveness state machine.
 *
 * Tracks a routed channel turn through its lifecycle and emits user-visible
 * or presence updates based on actual runtime signals, not blind timers.
 *
 * Anti-masking rule: never send a positive-progress text message ("I'm working
 * on it") unless at least one strong signal has been observed.
 */

import type { ChannelTurnSource, ToolCategory } from "@/channels/types";

// ── Constants ────────────────────────────────────────────────────────

/** Delay before dispatching a neutral ack event (internal use, adapters no longer send text by default). */
export const DISPATCH_ACK_DELAY_MS = 1500;

/**
 * Delay constant used by adapters that want delayed waiting text.
 * Liveness now emits tool-progress immediately; adapters may choose to delay
 * user-visible messages (e.g. message mode) using this value.
 */
export const TOOL_PROGRESS_DELAY_MS = 3000;

/** Interval for refreshing typing presence while in dispatched state (no tool call yet).
 *  WhatsApp typing presence auto-expires ~30s, so refresh at ~25s to keep it active. */
export const TYPING_REFRESH_INTERVAL_MS = 25000;

/** Hard timeout — force failed if no completion. */
export const HARD_TIMEOUT_MS = 90000;

// ── Types ────────────────────────────────────────────────────────────

/**
 * Strong signals that confirm meaningful work is happening.
 * At least one must be observed before any user-visible progress text is sent.
 */
export type StrongSignalReason =
  | "tool_call_message"
  | "approval_stop"
  | "non_empty_assistant_content"
  | "message_channel_tool_call";

/** Failure reason when the turn ends without a WhatsApp reply. */
export type TurnFailureReason =
  | "silent_end"
  | "silent_end_with_tools"
  | "provider_timeout"
  | "runtime_error"
  | "cancelled"
  | "approval_blocked";

export type TurnLivenessState =
  | "dispatched"
  | "strong"
  | "completed"
  | "failed";

export interface TurnLivenessMetadata {
  /** At least one strong signal was observed. */
  hadStrongSignal: boolean;
  /** A MessageChannel tool call was emitted during this turn. */
  hadMessageChannelCall: boolean;
  /** Any tool calls (including non-MessageChannel) were emitted. */
  hadToolCalls: boolean;
  /** Elapsed time in ms since first dispatch. */
  elapsedMs: number;
}

export interface TurnLivenessTimers {
  ack: ReturnType<typeof setTimeout> | null;
  typingRefresh: ReturnType<typeof setTimeout> | null;
  hard: ReturnType<typeof setTimeout> | null;
}

export interface TurnLivenessCallbacks {
  /**
   * Called when a neutral dispatch ack should be dispatched (internal use).
   * This is only called in "dispatched" state. Adapters no longer send text
   * for this event by default — it's kept for typing-presence refresh.
   *
   * Also called periodically (at TYPING_REFRESH_INTERVAL_MS) while in
   * "dispatched" state to keep the typing indicator alive.
   */
  onDispatchAck: (sources: ChannelTurnSource[]) => void | Promise<void>;

  /**
   * Called when tool work has been active beyond TOOL_PROGRESS_DELAY_MS.
   * Only called once per turn, from "strong" state with a tool-call strong signal.
   */
  onToolProgress: (
    sources: ChannelTurnSource[],
    toolCategory: ToolCategory,
  ) => void | Promise<void>;

  /**
   * Called with failure reason when user-visible closeout is needed.
   */
  onFailed: (
    sources: ChannelTurnSource[],
    reason: TurnFailureReason,
    metadata: TurnLivenessMetadata,
  ) => void | Promise<void>;

  /**
   * Called when the turn completed successfully (MessageChannel sent).
   */
  onCompleted: (sources: ChannelTurnSource[]) => void | Promise<void>;
}

// ── State machine ─────────────────────────────────────────────────────

export class ChannelTurnLiveness {
  private _state: TurnLivenessState = "dispatched";
  private readonly sources: ChannelTurnSource[];
  private readonly callbacks: TurnLivenessCallbacks;
  private readonly timers: TurnLivenessTimers = {
    ack: null,
    typingRefresh: null,
    hard: null,
  };
  private readonly startMs: number;
  private readonly abortController?: AbortController;

  private metadata: TurnLivenessMetadata = {
    hadStrongSignal: false,
    hadMessageChannelCall: false,
    hadToolCalls: false,
    elapsedMs: 0,
  };

  private stopped = false;
  private toolProgressEmitted = false;

  constructor(
    sources: ChannelTurnSource[],
    callbacks: TurnLivenessCallbacks,
    options?: { abortController?: AbortController },
  ) {
    this.sources = sources;
    this.callbacks = callbacks;
    this.startMs = Date.now();
    this.abortController = options?.abortController;
    this.startTimers();
  }

  /** Returns elapsed time in ms since construction. */
  elapsed(): number {
    this.metadata.elapsedMs = Date.now() - this.startMs;
    return this.metadata.elapsedMs;
  }

  /** Elapsed time in ms via property access (alias for elapsed()). */
  get elapsedMs(): number {
    return this.elapsed();
  }

  private startTimers(): void {
    // Ack timer — fires once at DISPATCH_ACK_DELAY_MS if still dispatched.
    // After ack fires, arm the typing-refresh loop to keep the typing indicator
    // alive while no strong signal has been observed.
    this.timers.ack = setTimeout(async () => {
      if (this.stopped || this._state !== "dispatched") return;
      await this.callbacks.onDispatchAck(this.sources);
      // Arm the typing-refresh loop — re-arms itself every TYPING_REFRESH_INTERVAL_MS.
      // Only active while in "dispatched" state (cancelled on strong signal or stop).
      this.scheduleTypingRefresh();
    }, DISPATCH_ACK_DELAY_MS);

    // Hard timeout — abort runtime then signal failure
    this.timers.hard = setTimeout(async () => {
      if (
        this.stopped ||
        this._state === "completed" ||
        this._state === "failed"
      )
        return;
      this.abortController?.abort();
      const reason: TurnFailureReason = "provider_timeout";
      this.stop();
      await this.callbacks.onFailed(this.sources, reason, {
        ...this.metadata,
        hadStrongSignal: this.metadata.hadStrongSignal,
        hadMessageChannelCall: this.metadata.hadMessageChannelCall,
        hadToolCalls: this.metadata.hadToolCalls,
        elapsedMs: this.elapsed(),
      });
    }, HARD_TIMEOUT_MS);
  }

  /** Schedule a single typing-refresh tick and re-arm on completion. */
  private scheduleTypingRefresh(): void {
    if (this.stopped || this._state !== "dispatched") return;
    this.timers.typingRefresh = setTimeout(async () => {
      if (this.stopped || this._state !== "dispatched") return;
      await this.callbacks.onDispatchAck(this.sources);
      // Re-arm for next interval
      this.scheduleTypingRefresh();
    }, TYPING_REFRESH_INTERVAL_MS);
  }

  /**
   * Record a strong signal — transitions to "strong" state.
   * Once in "strong", stays there (re-entry is safe).
   *
   * @param reason - The strong signal reason.
   * @param toolCategory - Tool category for progress UX. Only meaningful for
   *   tool-call signals. Emits onToolProgress immediately for non-MessageChannel
   *   tool calls; adapters can decide whether to delay display.
   */
  signalStrong(reason: StrongSignalReason, toolCategory?: ToolCategory): void {
    if (this.stopped) return;
    this.elapsed();
    this.metadata.hadStrongSignal = true;
    // Tool calls occurred for both tool_call_message and message_channel_tool_call
    // (MessageChannel is itself a tool — its emission means tool calls happened).
    this.metadata.hadToolCalls ||=
      reason === "tool_call_message" || reason === "message_channel_tool_call";
    this.metadata.hadMessageChannelCall ||=
      reason === "message_channel_tool_call";

    // Cancel typing-refresh loop — we have real evidence now
    if (this.timers.typingRefresh) {
      clearTimeout(this.timers.typingRefresh);
      this.timers.typingRefresh = null;
    }

    if (this._state !== "strong") {
      this._state = "strong";
      // Cancel the ack timer — we have real evidence now
      if (this.timers.ack) {
        clearTimeout(this.timers.ack);
        this.timers.ack = null;
      }
    }

    // Emit tool-progress immediately on first non-MessageChannel tool signal.
    // This allows reaction mode to feel instant; adapters may still delay text.
    if (
      toolCategory &&
      reason !== "message_channel_tool_call" &&
      this.metadata.hadToolCalls &&
      !this.toolProgressEmitted
    ) {
      this.toolProgressEmitted = true;
      Promise.resolve(
        this.callbacks.onToolProgress(this.sources, toolCategory),
      ).catch(() => {});
    }
  }

  /**
   * Record that MessageChannel was emitted — immediate completion path.
   * Clears all pending timers and marks completed.
   */
  complete(): void {
    if (this.stopped) return;
    this.metadata.hadMessageChannelCall = true;
    this.metadata.hadStrongSignal ||= true;
    this.stop();
    this._state = "completed";
    Promise.resolve(this.callbacks.onCompleted(this.sources)).catch(() => {});
  }

  /**
   * Record failure with reason.
   * Clearsa all pending timers.
   */
  fail(reason: TurnFailureReason): void {
    if (this.stopped) return;
    this.stop();
    this._state = "failed";
    const elapsed = this.elapsed();
    Promise.resolve(
      this.callbacks.onFailed(this.sources, reason, {
        ...this.metadata,
        elapsedMs: elapsed,
      }),
    ).catch(() => {});
  }

  /**
   * Alias for signaling turn completion or failure from turn.ts.
   * Maps "completed" to success, all others to failure.
   */
  signalEnd(reason: TurnFailureReason | "completed"): void {
    if (reason === "completed") {
      this.complete();
    } else {
      this.fail(reason);
    }
  }

  /**
   * Signal that the turn ended at end_turn without a successful MessageChannel
   * send. Chooses silent_end vs silent_end_with_tools based on metadata.
   */
  endTurnSilent(): void {
    if (this.stopped) return;
    if (this.metadata.hadToolCalls) {
      this.fail("silent_end_with_tools");
    } else {
      this.fail("silent_end");
    }
  }

  private stop(): void {
    this.stopped = true;
    for (const timer of Object.values(this.timers)) {
      if (timer) clearTimeout(timer);
    }
    this.timers.ack = null;
    this.timers.typingRefresh = null;
    this.timers.hard = null;
  }

  /** Current state for reading after construction. */
  get state(): TurnLivenessState {
    return this._state;
  }

  getState(): TurnLivenessState {
    return this._state;
  }

  getMetadata(): TurnLivenessMetadata {
    return { ...this.metadata };
  }

  /**
   * Should auto-retry? Only if silent_end with no tool calls.
   */
  shouldAutoRetry(): boolean {
    return (
      this.metadata.hadToolCalls === false &&
      this.metadata.hadMessageChannelCall === false
    );
  }

  /**
   * Should send fallback? Always for silent end, regardless of tools.
   */
  shouldSendFallback(reason: TurnFailureReason): boolean {
    return reason === "silent_end" || reason === "silent_end_with_tools";
  }
}

/**
 * Classify the end_turn outcome from liveness metadata.
 *
 * Used by turn.ts to decide what to signal when the runtime hits end_turn
 * without a successful MessageChannel send.
 *
 * - MessageChannel was seen → "completed" (reply was delivered or attempted)
 * - Tools ran but no MessageChannel → "silent_end_with_tools" (side effects, ask user)
 * - No tools at all → "silent_end" (agent finished silently)
 */
/**
 * Map a tool name to its category for liveness progress UX.
 *
 * Ordering rules:
 * 1. `message_channel` / `MessageChannel` must match before any prefix check.
 * 2. `ssh` must match before `bash` (so `ssh_run` is not misclassified as bash).
 * 3. `bash` also checks `sh` prefix (covers `sh`, `shell`, `sh_run`, etc.).
 * 4. File tools match on common prefixes and `file` substring.
 * 5. Search tools match on semantic substrings.
 * 6. Everything else falls through to `generic`.
 */
export function classifyToolCategory(toolName: string): ToolCategory {
  const lower = toolName.toLowerCase();
  if (lower === "messagechannel" || lower === "message_channel")
    return "message_channel";
  if (lower.startsWith("ssh")) return "ssh";
  if (lower.startsWith("bash") || lower.startsWith("sh")) return "bash";
  if (
    lower.startsWith("read") ||
    lower.startsWith("write") ||
    lower.startsWith("edit") ||
    lower.startsWith("glob") ||
    lower.startsWith("grep") ||
    lower.includes("file")
  )
    return "file";
  if (
    lower.includes("search") ||
    lower.includes("web") ||
    lower.includes("fetch") ||
    lower.includes("exa")
  )
    return "search";
  return "generic";
}

export function classifyEndTurnOutcome(
  metadata: TurnLivenessMetadata,
): "completed" | TurnFailureReason {
  if (metadata.hadMessageChannelCall) {
    return "completed";
  }
  if (metadata.hadToolCalls) {
    return "silent_end_with_tools";
  }
  return "silent_end";
}
