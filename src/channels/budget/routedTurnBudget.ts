/**
 * Routed Turn Budget Tracker
 *
 * Enforces runtime execution budgets for WhatsApp-routed turns:
 * - Total tool call count
 * - Heavy bash call count
 * - Elapsed time
 * - Auto-progress fallback
 */

import type { ChannelTurnSource } from "@/channels/types";
import { isHeavyBashCommand } from "./heavyBashClassifier";

// Default budget limits
const DEFAULT_MAX_TOOL_CALLS = 8;
const DEFAULT_MAX_HEAVY_BASH = 2;
const DEFAULT_MAX_ELAPSED_MS = 35000;
const DEFAULT_AUTO_PROGRESS_AFTER_MS = 7000;
const DEFAULT_PROGRESS_MESSAGE =
  "Processing your request. I'll update you shortly.";

export type BudgetReason =
  | "budget_tool_calls_exceeded"
  | "budget_heavy_bash_exceeded"
  | "budget_elapsed_exceeded";

export interface RoutedTurnBudgetConfig {
  maxToolCalls: number;
  maxHeavyBashCalls: number;
  maxElapsedMs: number;
  autoProgressAfterMs: number;
  autoProgressMessage: string;
}

export interface RoutedTurnBudgetCallbacks {
  onBudgetExceeded: (
    sources: ChannelTurnSource[],
    reason: BudgetReason,
  ) => void | Promise<void>;
  onAutoProgress: (
    sources: ChannelTurnSource[],
    message: string,
  ) => void | Promise<void>;
}

export interface RoutedTurnBudgetState {
  toolCallsUsed: number;
  heavyBashUsed: number;
  autoProgressSent: boolean;
  blocked: boolean;
  blockedReason?: BudgetReason;
}

export class RoutedTurnBudget {
  private readonly config: RoutedTurnBudgetConfig;
  private readonly callbacks: RoutedTurnBudgetCallbacks;
  private readonly startMs: number;
  private readonly turnSources: ChannelTurnSource[] = [];

  private state: RoutedTurnBudgetState = {
    toolCallsUsed: 0,
    heavyBashUsed: 0,
    autoProgressSent: false,
    blocked: false,
  };

  private autoProgressTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    config: Partial<RoutedTurnBudgetConfig>,
    callbacks: RoutedTurnBudgetCallbacks,
    sources: ChannelTurnSource[] = [],
  ) {
    this.config = {
      maxToolCalls: config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
      maxHeavyBashCalls: config.maxHeavyBashCalls ?? DEFAULT_MAX_HEAVY_BASH,
      maxElapsedMs: config.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS,
      autoProgressAfterMs:
        config.autoProgressAfterMs ?? DEFAULT_AUTO_PROGRESS_AFTER_MS,
      autoProgressMessage:
        config.autoProgressMessage ?? DEFAULT_PROGRESS_MESSAGE,
    };
    this.callbacks = callbacks;
    this.startMs = Date.now();
    this.turnSources = sources;

    // Arm auto-progress timer
    if (this.config.autoProgressAfterMs > 0) {
      this.autoProgressTimer = setTimeout(async () => {
        if (!this.state.autoProgressSent && !this.state.blocked) {
          this.state.autoProgressSent = true;
          await this.callbacks.onAutoProgress(
            this.turnSources,
            this.config.autoProgressMessage,
          );
        }
      }, this.config.autoProgressAfterMs);
    }
  }

  elapsed(): number {
    return Date.now() - this.startMs;
  }

  /**
   * Record a tool call and check if it should be blocked.
   * Returns true if the call should proceed, false if blocked.
   */
  recordToolCall(
    toolName: string,
    args?: Record<string, unknown>,
    sources?: ChannelTurnSource[],
  ): boolean {
    if (this.state.blocked) {
      return false;
    }

    const isHeavy = isHeavyBashCommand(
      toolName === "Bash" && args?.command
        ? String(args.command)
        : toolName === "bash" && args?.command
          ? String(args.command)
          : "",
    );

    this.state.toolCallsUsed++;

    if (isHeavy) {
      this.state.heavyBashUsed++;
    }

    // Log budget status
    const elapsed = this.elapsed();
    console.log(
      `[Channels] routed budget: heavy=${this.state.heavyBashUsed}/${this.config.maxHeavyBashCalls} total=${this.state.toolCallsUsed}/${this.config.maxToolCalls} elapsed=${elapsed}ms`,
    );

    // Check budgets and potentially block
    const srcs = sources ?? [];

    if (isHeavy && this.state.heavyBashUsed > this.config.maxHeavyBashCalls) {
      this.block("budget_heavy_bash_exceeded", srcs);
      return false;
    }

    if (this.state.toolCallsUsed > this.config.maxToolCalls) {
      this.block("budget_tool_calls_exceeded", srcs);
      return false;
    }

    if (elapsed > this.config.maxElapsedMs) {
      this.block("budget_elapsed_exceeded", srcs);
      return false;
    }

    return true;
  }

  private block(reason: BudgetReason, sources: ChannelTurnSource[]): void {
    this.state.blocked = true;
    this.state.blockedReason = reason;

    if (this.autoProgressTimer) {
      clearTimeout(this.autoProgressTimer);
      this.autoProgressTimer = null;
    }

    console.log(
      `[Channels] routed budget stop: ${reason} heavy=${this.state.heavyBashUsed}/${this.config.maxHeavyBashCalls} total=${this.state.toolCallsUsed}/${this.config.maxToolCalls} elapsed=${this.elapsed()}ms`,
    );

    this.callbacks.onBudgetExceeded(sources, reason);
  }

  /**
   * Get current budget state for logging.
   */
  getState(): RoutedTurnBudgetState & { elapsedMs: number } {
    return {
      ...this.state,
      elapsedMs: this.elapsed(),
    };
  }

  /**
   * Note that a user-facing message was sent (cancel auto-progress).
   */
  noteMessageSent(): void {
    this.state.autoProgressSent = true;
    if (this.autoProgressTimer) {
      clearTimeout(this.autoProgressTimer);
      this.autoProgressTimer = null;
    }
  }

  /**
   * Check if turn is blocked due to budget.
   */
  isBlocked(): boolean {
    return this.state.blocked;
  }

  /**
   * Clean up timers/resources.
   */
  destroy(): void {
    if (this.autoProgressTimer) {
      clearTimeout(this.autoProgressTimer);
      this.autoProgressTimer = null;
    }
  }
}

/**
 * Extract budget config from account settings.
 */
export function getRoutedTurnBudgetConfig(account: {
  routedTurnMaxToolCalls?: number;
  routedTurnMaxHeavyBashCalls?: number;
  routedTurnMaxElapsedMs?: number;
  routedTurnAutoProgressAfterMs?: number;
  routedTurnAutoProgressMessage?: string;
}): Partial<RoutedTurnBudgetConfig> {
  return {
    maxToolCalls: account.routedTurnMaxToolCalls,
    maxHeavyBashCalls: account.routedTurnMaxHeavyBashCalls,
    maxElapsedMs: account.routedTurnMaxElapsedMs,
    autoProgressAfterMs: account.routedTurnAutoProgressAfterMs,
    autoProgressMessage: account.routedTurnAutoProgressMessage,
  };
}