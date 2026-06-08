import { afterEach, describe, expect, test, vi } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARD_TIMEOUT_MS } from "@/channels/turnLiveness";
import { ensureConversationQueueRuntime } from "@/websocket/listener/conversation-runtime";
import { processQueuedTurnWithWatchdog } from "@/websocket/listener/queue";
import { createConversationRuntime } from "@/websocket/listener/runtime";
import type { ListenerRuntime } from "@/websocket/listener/types";

function makeListener(): ListenerRuntime {
  return {
    socket: null,
    transport: null,
    streamSocket: null,
    streamTransport: null,
    heartbeatInterval: null,
    reconnectTimeout: null,
    intentionallyClosed: false,
    hasSuccessfulConnection: true,
    everConnected: true,
    sessionId: "test-session",
    eventSeqCounter: 0,
    lastStopReason: null,
    queueEmitScheduled: false,
    onWsEvent: undefined,
    reminderState: {} as ListenerRuntime["reminderState"],
    bootWorkingDirectory: "/work",
    workingDirectoryByConversation: new Map(),
    permissionModeByConversation: new Map(),
    reminderStateByConversation: new Map(),
    contextTrackerByConversation: new Map(),
    systemPromptRecompileByConversation: new Map(),
    conversationRuntimes: new Map(),
    approvalRuntimeKeyByRequestId: new Map(),
    pendingApprovalRuntimeKeyByToolCallId: new Map(),
    pendingApprovalRuntimeKeyByBatchId: new Map(),
    pendingQueueEmitScope: undefined,
    lastEmittedStatus: null,
    queueRuntime: null as never,
    messageQueue: Promise.resolve(),
    pendingApprovalResolvers: new Map(),
    recoveredApprovalState: null,
    lastTerminalLoopErrorMessage: null,
    isProcessing: false,
    activeWorkingDirectory: null,
    expectedWorktreePath: null,
    expectedWorktreeExpiresAt: null,
    activeRunId: null,
    activeRunStartedAt: null,
    activeAbortController: null,
    cancelRequested: false,
    queuePumpActive: false,
    queuePumpScheduled: false,
    pendingTurns: 0,
    isRecoveringApprovals: false,
    loopStatus: "WAITING_ON_INPUT",
    currentToolset: null,
    currentToolsetPreference: "auto",
    currentLoadedTools: [],
    pendingApprovalBatchByToolCallId: new Map(),
    pendingInterruptedResults: null,
    pendingInterruptedContext: null,
    continuationEpoch: 0,
    activeExecutingToolCallIds: [],
    pendingInterruptedToolCallIds: null,
    contextTracker: {} as never,
    activeChannelTurnSources: null,
    queuedMessagesByItemId: new Map(),
    key: "listener-runtime",
    agentId: null,
    conversationId: "default",
    type: "websocket",
  } as unknown as ListenerRuntime;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("channel routed turn stability", () => {
  test("turn.ts does not shadow channelLiveness away from catch/finally paths", () => {
    const source = readFileSync(
      join(process.cwd(), "src/websocket/listener/turn.ts"),
      "utf8",
    );
    expect(
      source.match(/let channelLiveness: ChannelTurnLiveness \| null = null;/g),
    ).toHaveLength(1);
    expect(source).not.toContain(
      "const liveness: ChannelTurnLiveness = channelLiveness!;",
    );
  });

  test("queue watchdog releases a routed turn that does not settle after timeout", async () => {
    vi.useFakeTimers();
    const listener = makeListener();
    const runtime = ensureConversationQueueRuntime(
      listener,
      createConversationRuntime(listener, "agent-1", "conv-1"),
    );
    const abortController = new AbortController();
    runtime.activeAbortController = abortController;
    runtime.isProcessing = true;
    runtime.loopStatus = "SENDING_API_REQUEST";

    const promise = processQueuedTurnWithWatchdog(
      runtime,
      {
        type: "message_create",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [],
        channelTurnSources: [
          {
            channel: "whatsapp",
            accountId: "main",
            chatId: "chat-1",
            messageId: "msg-1",
            agentId: "agent-1",
            conversationId: "conv-1",
          },
        ],
      } as never,
      { batchId: "batch-1", items: [], queueLenAfter: 0 } as never,
      () => new Promise<void>(() => {}),
    );

    vi.advanceTimersByTime(HARD_TIMEOUT_MS + 5_000);

    await expect(promise).rejects.toThrow("provider_timeout");
    expect(abortController.signal.aborted).toBe(true);
    expect(runtime.isProcessing).toBe(false);
    expect(runtime.activeAbortController).toBeNull();
    expect(runtime.loopStatus as string).toBe("WAITING_ON_INPUT");
  });
});
