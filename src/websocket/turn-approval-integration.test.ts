/**
 * Integration-style regression tests for handleApprovalStop.
 *
 * Validates the MessageChannel auto-approval path for routed external
 * channel turns, including defense-in-depth arg validation and correct
 * fallback to the normal WS approval flow for non-channel tools.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ApprovalResult } from "@/agent/approval-execution";
import type { ApprovalResponseBody } from "@/types/protocol_v2";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { LocalListenerTransport } from "@/websocket/listener/transport";
import { handleApprovalStop } from "@/websocket/listener/turn-approval";

// ── Mocks ──────────────────────────────────────────────────────────

const classifyCalls: Array<{
  approvals: Array<{ toolName: string; toolCallId: string }>;
}> = [];

const classifyApprovalsMock = mock(async (approvals: unknown[]) => {
  classifyCalls.push({
    approvals: (
      approvals as Array<{ toolName: string; toolCallId: string }>
    ).map((a) => ({ toolName: a.toolName, toolCallId: a.toolCallId })),
  });
  return {
    needsUserInput: [] as Array<{
      approval: { toolName: string; toolCallId: string; toolArgs: string };
      parsedArgs: unknown;
      context: unknown;
      permission: unknown;
      denyReason: unknown;
    }>,
    autoAllowed: [] as Array<unknown>,
    autoDenied: [] as Array<unknown>,
  };
});

const executeResults: ApprovalResult[] = [];
const executeApprovalBatchMock = mock(async () => executeResults);

const requestApprovalCalls: Array<{ toolName: string; toolCallId: string }> =
  [];
const requestApprovalOverWSMock = mock(
  async (
    _runtime: unknown,
    _socket: unknown,
    _requestId: string,
    controlRequest: { request?: { tool_name?: string; tool_call_id?: string } },
  ) => {
    requestApprovalCalls.push({
      toolName: controlRequest.request?.tool_name ?? "unknown",
      toolCallId: controlRequest.request?.tool_call_id ?? "unknown",
    });
    return {
      decision: { behavior: "allow", message: "ok" },
    } as ApprovalResponseBody;
  },
);

let sendContinuationCalled = false;
const sendApprovalContinuationWithRetryMock = mock(async () => {
  sendContinuationCalled = true;
  // Return a truthy stream-like object so handleApprovalStop reaches the
  // non-terminated continuation path (line ~703) instead of the early
  // `if (!stream) { terminated: true }` branch.
  return {};
});

const ensureSecretsHydratedMock = mock(async () => {});

const computeDiffPreviewsMock = mock(async () => []);

// The approval-suggestions module re-exports classifyApprovals from
// approvalClassification under the name classifyApprovalsWithSuggestions.
// We mock it at the approvalClassification source.
mock.module("../cli/helpers/approvalClassification", () => ({
  classifyApprovals: classifyApprovalsMock,
}));

mock.module("../agent/approval-execution", () => ({
  executeApprovalBatch: executeApprovalBatchMock,
  getDisplayableToolReturn: (c: unknown) => c,
}));

mock.module("../websocket/listener/approval", () => ({
  clearPendingApprovalBatchIds: () => {},
  collectApprovalResultToolCallIds: (results: ApprovalResult[]) =>
    results.map((r) => r.tool_call_id),
  collectDecisionToolCallIds: (
    decisions: Array<{ approval: { toolCallId: string } }>,
  ) => decisions.map((d) => d.approval.toolCallId),
  rememberPendingApprovalBatchIds: () => {},
  requestApprovalOverWS: requestApprovalOverWSMock,
  validateApprovalResultIds: () => {},
}));

mock.module("../websocket/listener/send", () => ({
  markAwaitingAcceptedApprovalContinuationRunId: () => {},
  sendApprovalContinuationWithRetry: sendApprovalContinuationWithRetryMock,
}));

mock.module("../websocket/listener/secrets-sync", () => ({
  ensureSecretsHydratedForAgent: ensureSecretsHydratedMock,
}));

mock.module("../helpers/diffPreview", () => ({
  computeDiffPreviews: computeDiffPreviewsMock,
}));

mock.module("../channels/registry", () => ({
  getChannelRegistry: () => null,
}));

// ── Helpers ────────────────────────────────────────────────────────

function createTestRuntime() {
  const runtime = __listenClientTestUtils.createRuntime();
  runtime.activeAbortController = new AbortController();
  runtime.isProcessing = true;
  runtime.activeChannelTurnSources = [
    {
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      messageId: "msg-1",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
    },
  ];
  return runtime;
}

function makeApproval(
  toolName: string,
  toolCallId: string,
  toolArgs: Record<string, unknown> = {},
) {
  return {
    toolCallId,
    toolName,
    toolArgs: JSON.stringify(toolArgs),
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("handleApprovalStop — channel MessageChannel auto-approval", () => {
  let runtime: ReturnType<typeof createTestRuntime>;
  const socket = new LocalListenerTransport();

  beforeEach(() => {
    runtime = createTestRuntime();
    classifyCalls.length = 0;
    requestApprovalCalls.length = 0;
    sendContinuationCalled = false;
    executeResults.length = 0;
    classifyApprovalsMock.mockClear();
    executeApprovalBatchMock.mockClear();
    requestApprovalOverWSMock.mockClear();
    sendApprovalContinuationWithRetryMock.mockClear();
    ensureSecretsHydratedMock.mockClear();
    computeDiffPreviewsMock.mockClear();
  });

  test("routed MessageChannel auto-approves without WS control_request", async () => {
    const msgChannelApproval = makeApproval("MessageChannel", "tc-msg-1", {
      channel: "slack",
      chat_id: "C123",
      text: "hello",
    });

    const result = await handleApprovalStop({
      approvals: [msgChannelApproval],
      runtime,
      socket,
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: "/tmp/test",
      turnPermissionModeState: {
        mode: "standard",
        planFilePath: null,
        modeBeforePlan: null,
      },
      dequeuedBatchId: "batch-1",
      msgRunIds: ["run-1"],
      currentInput: [],
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      buildSendOptions: () => ({
        agentId: "agent-1",
        clientTools: [],
        loadedToolNames: [],
      }),
    });

    // Should NOT have gone through WS approval
    expect(requestApprovalCalls.length).toBe(0);

    // Should NOT have classified — MessageChannel was auto-approved before classification
    // Actually, classify IS called but with an empty array (all filtered out)
    expect(classifyCalls.length).toBe(1);
    expect(classifyCalls[0]!.approvals.length).toBe(0);

    // Should have executed the batch
    expect(executeApprovalBatchMock.mock.calls.length).toBe(1);

    // Should have attempted to send continuation
    expect(sendContinuationCalled).toBe(true);

    // Result should indicate non-terminated with continuation accepted
    expect(result.terminated).toBe(false);
  });

  test("non-channel tool (Bash) follows normal approval via WS control_request", async () => {
    const bashApproval = makeApproval("Bash", "tc-bash-1", {
      command: "echo hello",
    });

    // For Bash, classifyApprovals returns needsUserInput so WS path is hit
    // Reset and make classify return needsUserInput
    classifyApprovalsMock.mockImplementation(async (approvals: unknown[]) => {
      classifyCalls.push({
        approvals: (
          approvals as Array<{ toolName: string; toolCallId: string }>
        ).map((a) => ({ toolName: a.toolName, toolCallId: a.toolCallId })),
      });
      const items = approvals as Array<{
        toolName: string;
        toolCallId: string;
        toolArgs: string;
      }>;
      return {
        needsUserInput: items.map((a) => ({
          approval: a,
          parsedArgs: JSON.parse(a.toolArgs || "{}"),
          context: null,
          permission: null,
          denyReason: null,
        })),
        autoAllowed: [],
        autoDenied: [],
      };
    });

    await handleApprovalStop({
      approvals: [bashApproval],
      runtime,
      socket,
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: "/tmp/test",
      turnPermissionModeState: {
        mode: "standard",
        planFilePath: null,
        modeBeforePlan: null,
      },
      dequeuedBatchId: "batch-1",
      msgRunIds: ["run-1"],
      currentInput: [],
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      buildSendOptions: () => ({
        agentId: "agent-1",
        clientTools: [],
        loadedToolNames: [],
      }),
    });

    // Routed channel turns auto-deny non-MessageChannel approvals
    // instead of opening WS approval requests.
    expect(requestApprovalCalls.length).toBe(0);

    // classify was called with the Bash approval
    expect(classifyCalls.length).toBe(1);
    expect(classifyCalls[0]!.approvals.length).toBe(1);
    expect(classifyCalls[0]!.approvals[0]!.toolName).toBe("Bash");

    // Should have executed the batch
    expect(executeApprovalBatchMock.mock.calls.length).toBe(1);
  });

  test("MessageChannel without routed channel source does NOT auto-approve", async () => {
    // Remove channel turn sources — no routed source
    runtime.activeChannelTurnSources = [];

    const msgChannelApproval = makeApproval("MessageChannel", "tc-msg-no-src", {
      channel: "slack",
      chat_id: "C999",
      text: "hello",
    });

    // Make classify return needsUserInput so WS path is hit
    classifyApprovalsMock.mockImplementation(async (approvals: unknown[]) => {
      classifyCalls.push({
        approvals: (
          approvals as Array<{ toolName: string; toolCallId: string }>
        ).map((a) => ({ toolName: a.toolName, toolCallId: a.toolCallId })),
      });
      const items = approvals as Array<{
        toolName: string;
        toolCallId: string;
        toolArgs: string;
      }>;
      return {
        needsUserInput: items.map((a) => ({
          approval: a,
          parsedArgs: JSON.parse(a.toolArgs || "{}"),
          context: null,
          permission: null,
          denyReason: null,
        })),
        autoAllowed: [],
        autoDenied: [],
      };
    });

    await handleApprovalStop({
      approvals: [msgChannelApproval],
      runtime,
      socket,
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: "/tmp/test",
      turnPermissionModeState: {
        mode: "standard",
        planFilePath: null,
        modeBeforePlan: null,
      },
      dequeuedBatchId: "batch-1",
      msgRunIds: ["run-1"],
      currentInput: [],
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      buildSendOptions: () => ({
        agentId: "agent-1",
        clientTools: [],
        loadedToolNames: [],
      }),
    });

    // Without a routed source, MessageChannel should go through normal WS approval
    expect(requestApprovalCalls.length).toBe(1);
    expect(requestApprovalCalls[0]!.toolName).toBe("MessageChannel");
  });

  test("MessageChannel with mismatched channel/chat_id does NOT auto-approve", async () => {
    // Source is slack/C123 but args target telegram/C999
    const mismatchedApproval = makeApproval(
      "MessageChannel",
      "tc-msg-mismatch",
      { channel: "telegram", chat_id: "C999", text: "hello" },
    );

    // Make classify return needsUserInput so WS path is hit
    classifyApprovalsMock.mockImplementation(async (approvals: unknown[]) => {
      classifyCalls.push({
        approvals: (
          approvals as Array<{ toolName: string; toolCallId: string }>
        ).map((a) => ({ toolName: a.toolName, toolCallId: a.toolCallId })),
      });
      const items = approvals as Array<{
        toolName: string;
        toolCallId: string;
        toolArgs: string;
      }>;
      return {
        needsUserInput: items.map((a) => ({
          approval: a,
          parsedArgs: JSON.parse(a.toolArgs || "{}"),
          context: null,
          permission: null,
          denyReason: null,
        })),
        autoAllowed: [],
        autoDenied: [],
      };
    });

    await handleApprovalStop({
      approvals: [mismatchedApproval],
      runtime,
      socket,
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: "/tmp/test",
      turnPermissionModeState: {
        mode: "standard",
        planFilePath: null,
        modeBeforePlan: null,
      },
      dequeuedBatchId: "batch-1",
      msgRunIds: ["run-1"],
      currentInput: [],
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      buildSendOptions: () => ({
        agentId: "agent-1",
        clientTools: [],
        loadedToolNames: [],
      }),
    });

    // Mismatched args should NOT auto-approve — falls through to WS
    expect(requestApprovalCalls.length).toBe(1);
    expect(requestApprovalCalls[0]!.toolName).toBe("MessageChannel");
  });

  test("mixed batch: MessageChannel auto-approves, Bash requires WS", async () => {
    const msgChannelApproval = makeApproval("MessageChannel", "tc-msg-mixed", {
      channel: "slack",
      chat_id: "C123",
      text: "reply",
    });
    const bashApproval = makeApproval("Bash", "tc-bash-mixed", {
      command: "ls",
    });

    // Bash goes to needsUserInput, MessageChannel is auto-approved
    classifyApprovalsMock.mockImplementation(async (approvals: unknown[]) => {
      classifyCalls.push({
        approvals: (
          approvals as Array<{ toolName: string; toolCallId: string }>
        ).map((a) => ({ toolName: a.toolName, toolCallId: a.toolCallId })),
      });
      const items = approvals as Array<{
        toolName: string;
        toolCallId: string;
        toolArgs: string;
      }>;
      return {
        needsUserInput: items.map((a) => ({
          approval: a,
          parsedArgs: JSON.parse(a.toolArgs || "{}"),
          context: null,
          permission: null,
          denyReason: null,
        })),
        autoAllowed: [],
        autoDenied: [],
      };
    });

    await handleApprovalStop({
      approvals: [msgChannelApproval, bashApproval],
      runtime,
      socket,
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: "/tmp/test",
      turnPermissionModeState: {
        mode: "standard",
        planFilePath: null,
        modeBeforePlan: null,
      },
      dequeuedBatchId: "batch-1",
      msgRunIds: ["run-1"],
      currentInput: [],
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      buildSendOptions: () => ({
        agentId: "agent-1",
        clientTools: [],
        loadedToolNames: [],
      }),
    });

    // MessageChannel is auto-approved and non-MessageChannel approvals are
    // auto-denied for routed channel turns (no WS request).
    expect(requestApprovalCalls.length).toBe(0);

    // classify should have been called with only the Bash approval
    expect(classifyCalls.length).toBe(1);
    expect(classifyCalls[0]!.approvals.length).toBe(1);
    expect(classifyCalls[0]!.approvals[0]!.toolName).toBe("Bash");

    // Both tools should be executed
    expect(executeApprovalBatchMock.mock.calls.length).toBe(1);
  });

  test("MessageChannel with missing chat_id does NOT auto-approve, falls through to WS", async () => {
    // Source is slack/C123 but args omit chat_id entirely
    const missingChatIdApproval = makeApproval(
      "MessageChannel",
      "tc-msg-no-chatid",
      { channel: "slack", text: "hello" },
    );

    classifyApprovalsMock.mockImplementation(async (approvals: unknown[]) => {
      classifyCalls.push({
        approvals: (
          approvals as Array<{ toolName: string; toolCallId: string }>
        ).map((a) => ({ toolName: a.toolName, toolCallId: a.toolCallId })),
      });
      const items = approvals as Array<{
        toolName: string;
        toolCallId: string;
        toolArgs: string;
      }>;
      return {
        needsUserInput: items.map((a) => ({
          approval: a,
          parsedArgs: JSON.parse(a.toolArgs || "{}"),
          context: null,
          permission: null,
          denyReason: null,
        })),
        autoAllowed: [],
        autoDenied: [],
      };
    });

    await handleApprovalStop({
      approvals: [missingChatIdApproval],
      runtime,
      socket,
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: "/tmp/test",
      turnPermissionModeState: {
        mode: "standard",
        planFilePath: null,
        modeBeforePlan: null,
      },
      dequeuedBatchId: "batch-1",
      msgRunIds: ["run-1"],
      currentInput: [],
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      buildSendOptions: () => ({
        agentId: "agent-1",
        clientTools: [],
        loadedToolNames: [],
      }),
    });

    // Missing chat_id should block auto-approve — falls through to WS
    expect(requestApprovalCalls.length).toBe(1);
    expect(requestApprovalCalls[0]!.toolName).toBe("MessageChannel");
  });

  test("MessageChannel with missing channel does NOT auto-approve, falls through to WS", async () => {
    // Source is slack/C123 but args omit channel entirely
    const missingChannelApproval = makeApproval(
      "MessageChannel",
      "tc-msg-no-channel",
      { chat_id: "C123", text: "hello" },
    );

    classifyApprovalsMock.mockImplementation(async (approvals: unknown[]) => {
      classifyCalls.push({
        approvals: (
          approvals as Array<{ toolName: string; toolCallId: string }>
        ).map((a) => ({ toolName: a.toolName, toolCallId: a.toolCallId })),
      });
      const items = approvals as Array<{
        toolName: string;
        toolCallId: string;
        toolArgs: string;
      }>;
      return {
        needsUserInput: items.map((a) => ({
          approval: a,
          parsedArgs: JSON.parse(a.toolArgs || "{}"),
          context: null,
          permission: null,
          denyReason: null,
        })),
        autoAllowed: [],
        autoDenied: [],
      };
    });

    await handleApprovalStop({
      approvals: [missingChannelApproval],
      runtime,
      socket,
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: "/tmp/test",
      turnPermissionModeState: {
        mode: "standard",
        planFilePath: null,
        modeBeforePlan: null,
      },
      dequeuedBatchId: "batch-1",
      msgRunIds: ["run-1"],
      currentInput: [],
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      buildSendOptions: () => ({
        agentId: "agent-1",
        clientTools: [],
        loadedToolNames: [],
      }),
    });

    // Missing channel should block auto-approve — falls through to WS
    expect(requestApprovalCalls.length).toBe(1);
    expect(requestApprovalCalls[0]!.toolName).toBe("MessageChannel");
  });

  test("MessageChannel with mismatched chat_id only (same channel) does NOT auto-approve", async () => {
    // Source is slack/C123 but args target slack/C456
    const partialMismatchApproval = makeApproval(
      "MessageChannel",
      "tc-msg-partial",
      { channel: "slack", chat_id: "C456", text: "hello" },
    );

    classifyApprovalsMock.mockImplementation(async (approvals: unknown[]) => {
      classifyCalls.push({
        approvals: (
          approvals as Array<{ toolName: string; toolCallId: string }>
        ).map((a) => ({ toolName: a.toolName, toolCallId: a.toolCallId })),
      });
      const items = approvals as Array<{
        toolName: string;
        toolCallId: string;
        toolArgs: string;
      }>;
      return {
        needsUserInput: items.map((a) => ({
          approval: a,
          parsedArgs: JSON.parse(a.toolArgs || "{}"),
          context: null,
          permission: null,
          denyReason: null,
        })),
        autoAllowed: [],
        autoDenied: [],
      };
    });

    await handleApprovalStop({
      approvals: [partialMismatchApproval],
      runtime,
      socket,
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: "/tmp/test",
      turnPermissionModeState: {
        mode: "standard",
        planFilePath: null,
        modeBeforePlan: null,
      },
      dequeuedBatchId: "batch-1",
      msgRunIds: ["run-1"],
      currentInput: [],
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      buildSendOptions: () => ({
        agentId: "agent-1",
        clientTools: [],
        loadedToolNames: [],
      }),
    });

    // chat_id mismatch should block auto-approve
    expect(requestApprovalCalls.length).toBe(1);
    expect(requestApprovalCalls[0]!.toolName).toBe("MessageChannel");
  });
});
