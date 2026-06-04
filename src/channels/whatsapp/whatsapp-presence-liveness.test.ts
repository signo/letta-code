/**
 * Tests for WhatsApp adapter presence/liveness behavior:
 * read receipts, typing indicators, waiting messages, sendDirectReply presence.
 */
import { describe, expect, mock, test } from "bun:test";
import type {
  ChannelAdapter,
  ChannelTurnSource,
  WhatsAppChannelAccount,
} from "@/channels/types";
import {
  buildWhatsAppReadReceiptKeys,
  shouldMarkWhatsAppReadReceipt,
} from "@/channels/whatsapp/adapter";

function makeAccount(
  overrides: Partial<WhatsAppChannelAccount> = {},
): WhatsAppChannelAccount {
  return {
    channel: "whatsapp",
    accountId: "test-wa",
    displayName: "Test WA",
    enabled: true,
    dmPolicy: "open",
    allowedUsers: ["*"],
    agentId: null,
    selfChatMode: true,
    groupMode: "disabled",
    ...overrides,
  } as WhatsAppChannelAccount;
}

function makeSource(
  overrides: Partial<ChannelTurnSource> = {},
): ChannelTurnSource {
  return {
    channel: "whatsapp",
    chatId: "584149145006@s.whatsapp.net",
    agentId: "agent-test",
    conversationId: "conv-test",
    ...overrides,
  };
}

// ── Pure helper tests ─────────────────────────────────────────────

describe("shouldMarkWhatsAppReadReceipt", () => {
  test("returns true for accepted direct messages", () => {
    expect(
      shouldMarkWhatsAppReadReceipt({ chatType: "direct", accepted: true }),
    ).toBe(true);
  });

  test("returns false when not accepted", () => {
    expect(
      shouldMarkWhatsAppReadReceipt({ chatType: "direct", accepted: false }),
    ).toBe(false);
  });

  test("returns false for channel (group) messages even when accepted", () => {
    expect(
      shouldMarkWhatsAppReadReceipt({ chatType: "channel", accepted: true }),
    ).toBe(false);
  });
});

describe("buildWhatsAppReadReceiptKeys", () => {
  test("builds keys with remoteJid and id only", () => {
    const keys = buildWhatsAppReadReceiptKeys({
      remoteJid: "584149145006@s.whatsapp.net",
      messageId: "msg-123",
    });
    expect(keys).toEqual([
      { remoteJid: "584149145006@s.whatsapp.net", id: "msg-123" },
    ]);
  });

  test("includes participant when provided", () => {
    const keys = buildWhatsAppReadReceiptKeys({
      remoteJid: "group@g.us",
      messageId: "msg-456",
      participant: "584149145006@s.whatsapp.net",
    });
    expect(keys[0]!.participant).toBe("584149145006@s.whatsapp.net");
  });

  test("omits participant when null", () => {
    const keys = buildWhatsAppReadReceiptKeys({
      remoteJid: "584149145006@s.whatsapp.net",
      messageId: "msg-789",
      participant: null,
    });
    expect(keys[0]!.participant).toBeUndefined();
  });
});

// ── Adapter integration with mock socket ──────────────────────────

function makeMockSock() {
  const presenceLog: Array<{ presence: string; jid?: string }> = [];
  const readMessagesLog: Array<Array<Record<string, unknown>>> = [];
  const sendMessageResults: Array<{
    jid: string;
    payload: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  let onConnectionUpdate: ((update: Record<string, unknown>) => void) | null =
    null;
  let onMessagesUpsert: ((event: unknown) => void) | null = null;

  const sock = {
    user: { id: "584149145006@s.whatsapp.net" },
    sendPresenceUpdate: mock(async (presence: string, jid?: string) => {
      presenceLog.push({ presence, jid });
    }),
    readMessages: mock(async (keys: Array<Record<string, unknown>>) => {
      readMessagesLog.push(keys);
    }),
    sendMessage: mock(
      async (
        jid: string,
        payload: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        sendMessageResults.push({ jid, payload, options });
        return { key: { id: `sent-${sendMessageResults.length}` } };
      },
    ),
    ev: {
      on: mock((event: string, handler: (payload: unknown) => void) => {
        if (event === "messages.upsert") {
          onMessagesUpsert = handler;
        }
      }),
    },
    ws: { close: mock(() => {}) },
  };

  return {
    sock,
    presenceLog,
    readMessagesLog,
    sendMessageResults,
    getOnConnectionUpdate: () => onConnectionUpdate,
    getOnMessagesUpsert: () => onMessagesUpsert,
    setOnConnectionUpdate: (fn: (update: Record<string, unknown>) => void) => {
      onConnectionUpdate = fn;
    },
  };
}

async function createStartedAdapter(
  mockData: ReturnType<typeof makeMockSock>,
  accountOverrides: Partial<WhatsAppChannelAccount> = {},
) {
  mock.module("./session", () => ({
    createWhatsAppSocket: mock(
      async (params: {
        onConnectionUpdate?: (update: Record<string, unknown>) => void;
      }) => {
        if (params.onConnectionUpdate) {
          mockData.setOnConnectionUpdate(params.onConnectionUpdate);
        }
        return { sock: mockData.sock, release: () => {} };
      },
    ),
    getWhatsAppAuthDir: () => "/tmp/test-wa-auth",
  }));

  mock.module("./runtime", () => ({
    loadWhatsAppModule: mock(async () => ({
      downloadContentFromMessage: async function* () {
        yield new Uint8Array(0);
      },
    })),
  }));

  const { createWhatsAppAdapter: freshCreate } = await import("./adapter");
  const adapter: ChannelAdapter = freshCreate(makeAccount(accountOverrides));
  await adapter.start();

  const connHandler = mockData.getOnConnectionUpdate();
  if (connHandler) connHandler({ connection: "open" });

  return adapter;
}

// ── Read receipt tests ────────────────────────────────────────────

describe("WhatsApp read receipts", () => {
  test("inbound DM triggers readMessages call", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData);

    const upsertHandler = mockData.getOnMessagesUpsert();
    expect(upsertHandler).not.toBeNull();

    await upsertHandler!({
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "584149145006@s.whatsapp.net",
            id: "inbound-msg-1",
            fromMe: false,
          },
          message: { conversation: "hello" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          pushName: "TestUser",
        },
      ],
    });

    expect(mockData.readMessagesLog.length).toBeGreaterThan(0);
    expect(mockData.readMessagesLog[0]![0]).toEqual(
      expect.objectContaining({
        remoteJid: "584149145006@s.whatsapp.net",
        id: "inbound-msg-1",
      }),
    );

    await adapter.stop();
  });

  test("read receipt does not fire for group messages", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      selfChatMode: false,
      groupMode: "open",
      allowedGroups: ["*"],
    });

    const upsertHandler = mockData.getOnMessagesUpsert();
    expect(upsertHandler).not.toBeNull();

    await upsertHandler!({
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "123456@g.us",
            id: "group-msg-1",
            fromMe: false,
            participant: "584149145006@s.whatsapp.net",
          },
          message: { conversation: "hello group" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          pushName: "GroupUser",
        },
      ],
    });

    expect(mockData.readMessagesLog.length).toBe(0);
    await adapter.stop();
  });
});

// ── waitingBehavior="off" (default) ──────────────────────────────

describe("waitingBehavior=off (default)", () => {
  test("processing does NOT start typing when waitingBehavior is off", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "off",
    });

    await adapter.handleTurnLifecycleEvent!({
      type: "processing",
      batchId: "batch-1",
      sources: [makeSource()],
    });

    expect(mockData.presenceLog.some((p) => p.presence === "composing")).toBe(
      false,
    );

    await adapter.stop();
  });

  test("default (undefined waitingBehavior) suppresses typing", async () => {
    const mockData = makeMockSock();
    // No waitingBehavior set — defaults to "off"
    const adapter = await createStartedAdapter(mockData);

    await adapter.handleTurnLifecycleEvent!({
      type: "processing",
      batchId: "batch-1",
      sources: [makeSource()],
    });

    expect(mockData.presenceLog.some((p) => p.presence === "composing")).toBe(
      false,
    );

    await adapter.stop();
  });

  test("tool_waiting does NOT send message when waitingBehavior is off", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "off",
    });

    await adapter.handleTurnLivenessEvent!({
      type: "tool_waiting",
      batchId: "batch-1",
      sources: [makeSource()],
      toolCategory: "bash",
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(mockData.sendMessageResults.length).toBe(0);
    await adapter.stop();
  });

  test("typing_refresh is a no-op when waitingBehavior is off", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "off",
    });

    await adapter.handleTurnLivenessEvent!({
      type: "typing_refresh",
      batchId: "batch-1",
      sources: [makeSource()],
    });

    expect(mockData.presenceLog.length).toBe(0);
    await adapter.stop();
  });
});

// ── waitingBehavior="typing_indicator" ────────────────────────────

describe("waitingBehavior=typing_indicator", () => {
  test("processing starts typing indicator", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "typing_indicator",
    });

    await adapter.handleTurnLifecycleEvent!({
      type: "processing",
      batchId: "batch-1",
      sources: [makeSource()],
    });

    expect(mockData.presenceLog.some((p) => p.presence === "composing")).toBe(
      true,
    );

    await adapter.stop();
  });

  test("typing_refresh sends another composing presence (force refresh)", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "typing_indicator",
    });
    const source = makeSource();

    // Start typing
    await adapter.handleTurnLifecycleEvent!({
      type: "processing",
      batchId: "batch-1",
      sources: [source],
    });

    const composingAfterStart = mockData.presenceLog.filter(
      (p) => p.presence === "composing",
    ).length;
    expect(composingAfterStart).toBeGreaterThanOrEqual(1);

    // typing_refresh should force another composing
    await adapter.handleTurnLivenessEvent!({
      type: "typing_refresh",
      batchId: "batch-1",
      sources: [source],
    });

    const composingAfterRefresh = mockData.presenceLog.filter(
      (p) => p.presence === "composing",
    ).length;
    expect(composingAfterRefresh).toBeGreaterThan(composingAfterStart);

    await adapter.stop();
  });

  test("finished stops typing (paused presence)", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "typing_indicator",
    });
    const source = makeSource();

    await adapter.handleTurnLifecycleEvent!({
      type: "processing",
      batchId: "batch-1",
      sources: [source],
    });

    await adapter.handleTurnLifecycleEvent!({
      type: "finished",
      batchId: "batch-1",
      sources: [source],
      outcome: "completed",
    });

    expect(mockData.presenceLog.some((p) => p.presence === "paused")).toBe(
      true,
    );

    await adapter.stop();
  });

  test("tool_waiting does NOT send waiting message", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "typing_indicator",
    });

    await adapter.handleTurnLivenessEvent!({
      type: "tool_waiting",
      batchId: "batch-1",
      sources: [makeSource()],
      toolCategory: "bash",
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    // typing_indicator mode does not send waiting messages
    expect(mockData.sendMessageResults.length).toBe(0);
    await adapter.stop();
  });
});

// ── waitingBehavior="message" ─────────────────────────────────────

describe("waitingBehavior=message", () => {
  test("processing starts typing indicator", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "message",
    });

    await adapter.handleTurnLifecycleEvent!({
      type: "processing",
      batchId: "batch-1",
      sources: [makeSource()],
    });

    expect(mockData.presenceLog.some((p) => p.presence === "composing")).toBe(
      true,
    );

    await adapter.stop();
  });

  test("tool_waiting sends delayed waiting message", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "message",
      waitingMessage: "Working on it...",
    });

    await adapter.handleTurnLivenessEvent!({
      type: "tool_waiting",
      batchId: "batch-1",
      sources: [makeSource()],
      toolCategory: "bash",
    });

    // Waiting message is sent after WAITING_MESSAGE_DELAY_MS (3s)
    await new Promise((resolve) => setTimeout(resolve, 3500));

    const textMessages = mockData.sendMessageResults.filter(
      (r) => (r.payload as Record<string, unknown>).text === "Working on it...",
    );
    expect(textMessages.length).toBeGreaterThan(0);

    await adapter.stop();
  });

  test("tool_waiting uses default waiting message when none configured", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "message",
      // No waitingMessage set — should use default
    });

    await adapter.handleTurnLivenessEvent!({
      type: "tool_waiting",
      batchId: "batch-1",
      sources: [makeSource()],
      toolCategory: "bash",
    });

    await new Promise((resolve) => setTimeout(resolve, 3500));

    const textMessages = mockData.sendMessageResults.filter(
      (r) => typeof (r.payload as Record<string, unknown>).text === "string",
    );
    expect(textMessages.length).toBeGreaterThan(0);
    // Default message
    expect((textMessages[0]!.payload as Record<string, unknown>).text).toBe(
      "Let me do some work. I'll be back...",
    );

    await adapter.stop();
  });

  test("typing_refresh sends another composing presence", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "message",
    });
    const source = makeSource();

    await adapter.handleTurnLifecycleEvent!({
      type: "processing",
      batchId: "batch-1",
      sources: [source],
    });

    const composingAfterStart = mockData.presenceLog.filter(
      (p) => p.presence === "composing",
    ).length;

    await adapter.handleTurnLivenessEvent!({
      type: "typing_refresh",
      batchId: "batch-1",
      sources: [source],
    });

    const composingAfterRefresh = mockData.presenceLog.filter(
      (p) => p.presence === "composing",
    ).length;
    expect(composingAfterRefresh).toBeGreaterThan(composingAfterStart);

    await adapter.stop();
  });
});

// ── sendDirectReply presence (independent of waitingBehavior) ─────

describe("sendDirectReply presence", () => {
  test("sends composing before and paused after regardless of waitingBehavior", async () => {
    const mockData = makeMockSock();
    // waitingBehavior=off — sendDirectReply still does presence
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "off",
    });

    await adapter.sendDirectReply!(
      "584149145006@s.whatsapp.net",
      "direct reply text",
    );

    const composingBefore = mockData.presenceLog.findIndex(
      (p) => p.presence === "composing",
    );
    const pausedAfter = mockData.presenceLog.findIndex(
      (p) => p.presence === "paused",
    );
    expect(composingBefore).toBeGreaterThanOrEqual(0);
    expect(pausedAfter).toBeGreaterThan(composingBefore);

    await adapter.stop();
  });
});
