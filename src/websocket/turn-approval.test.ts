import { describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import {
  resolveChannelApprovalSource,
  shouldAutoApproveChannelMessageTool,
} from "@/websocket/listener/turn-approval";

describe("resolveChannelApprovalSource", () => {
  test("keeps channel approvals attached when coalesced messages share one logical scope", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.activeChannelTurnSources = [
      {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000100",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000200",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ];

    expect(resolveChannelApprovalSource(runtime)).toEqual(
      runtime.activeChannelTurnSources[1] ?? null,
    );
  });

  test("falls back to websocket approval when a coalesced turn spans multiple channel scopes", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.activeChannelTurnSources = [
      {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000100",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      {
        channel: "telegram",
        accountId: "acct-telegram",
        chatId: "987654",
        chatType: "direct",
        messageId: "42",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ];

    expect(resolveChannelApprovalSource(runtime)).toBeNull();
  });

  test("auto-approves MessageChannel only when args match the single routed channel turn", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.activeChannelTurnSources = [
      {
        channel: "whatsapp",
        accountId: "acct-whatsapp",
        chatId: "210565536456917@lid",
        chatType: "direct",
        messageId: "msg-1",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ];

    // Matching args → auto-approve
    expect(
      shouldAutoApproveChannelMessageTool({
        runtime,
        toolName: "MessageChannel",
        toolArgs: JSON.stringify({
          channel: "whatsapp",
          chat_id: "210565536456917@lid",
          text: "hello",
        }),
      }),
    ).toBe(true);

    // Non-MessageChannel tool → never auto-approve
    expect(
      shouldAutoApproveChannelMessageTool({
        runtime,
        toolName: "Bash",
        toolArgs: JSON.stringify({ command: "echo hi" }),
      }),
    ).toBe(false);

    // No toolArgs → no auto-approve
    expect(
      shouldAutoApproveChannelMessageTool({
        runtime,
        toolName: "MessageChannel",
      }),
    ).toBe(false);

    // Missing channel in args → no auto-approve
    expect(
      shouldAutoApproveChannelMessageTool({
        runtime,
        toolName: "MessageChannel",
        toolArgs: JSON.stringify({ chat_id: "210565536456917@lid", text: "x" }),
      }),
    ).toBe(false);

    // Missing chat_id in args → no auto-approve
    expect(
      shouldAutoApproveChannelMessageTool({
        runtime,
        toolName: "MessageChannel",
        toolArgs: JSON.stringify({ channel: "whatsapp", text: "x" }),
      }),
    ).toBe(false);

    // Mismatched channel → no auto-approve
    expect(
      shouldAutoApproveChannelMessageTool({
        runtime,
        toolName: "MessageChannel",
        toolArgs: JSON.stringify({
          channel: "telegram",
          chat_id: "210565536456917@lid",
          text: "x",
        }),
      }),
    ).toBe(false);

    // Mismatched chat_id → no auto-approve
    expect(
      shouldAutoApproveChannelMessageTool({
        runtime,
        toolName: "MessageChannel",
        toolArgs: JSON.stringify({
          channel: "whatsapp",
          chat_id: "DIFFERENT",
          text: "x",
        }),
      }),
    ).toBe(false);

    // No routed source → no auto-approve even with matching args
    runtime.activeChannelTurnSources = [];
    expect(
      shouldAutoApproveChannelMessageTool({
        runtime,
        toolName: "MessageChannel",
        toolArgs: JSON.stringify({
          channel: "whatsapp",
          chat_id: "210565536456917@lid",
          text: "x",
        }),
      }),
    ).toBe(false);
  });
});
