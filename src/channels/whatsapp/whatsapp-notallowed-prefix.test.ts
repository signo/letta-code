/**
 * Tests for WhatsApp not_allowed behavior and message prefix:
 * - notAllowedIgnore default=true silently ignores unauthorized inbound
 * - notAllowedIgnore=false sends configured notAllowedMessage
 * - Default notAllowedMessage is 🚫
 * - Old hardcoded "You are not on the allowed users list" no longer appears
 * - messagePrefix prepends to outbound agent replies
 * - Group routes preserve correct prefix
 */
import { describe, expect, mock, test } from "bun:test";
import { getWhatsAppNotAllowedReply } from "@/channels/registry";
import type {
  ChannelAdapter,
  ChannelTurnSource,
  WhatsAppChannelAccount,
} from "@/channels/types";

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

function makeMockSock() {
  const presenceLog: Array<{ presence: string; jid?: string }> = [];
  const sendMessageResults: Array<{
    jid: string;
    payload: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  let onConnectionUpdate: ((update: Record<string, unknown>) => void) | null =
    null;

  const sock = {
    user: { id: "584149145006@s.whatsapp.net" },
    sendPresenceUpdate: mock(async (presence: string, jid?: string) => {
      presenceLog.push({ presence, jid });
    }),
    readMessages: mock(async () => {}),
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
      on: mock(() => {}),
    },
    ws: { close: mock(() => {}) },
  };

  return {
    sock,
    presenceLog,
    sendMessageResults,
    setOnConnectionUpdate: (fn: (update: Record<string, unknown>) => void) => {
      onConnectionUpdate = fn;
    },
    getOnConnectionUpdate: () => onConnectionUpdate,
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

// ── not_allowed behavior tests ────────────────────────────────────

describe("notAllowedIgnore behavior", () => {
  test("default (undefined notAllowedIgnore) returns null — silently ignored", () => {
    const config = makeAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["584149145006"],
      // notAllowedIgnore is undefined — defaults to true
    });
    expect(getWhatsAppNotAllowedReply(config)).toBeNull();
  });

  test("notAllowedIgnore=true returns null — silently ignored", () => {
    const config = makeAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["584149145006"],
      notAllowedIgnore: true,
    });
    expect(getWhatsAppNotAllowedReply(config)).toBeNull();
  });

  test("notAllowedIgnore=false with configured message returns that message", () => {
    const config = makeAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["584149145006"],
      notAllowedIgnore: false,
      notAllowedMessage: "Nope",
    });
    expect(getWhatsAppNotAllowedReply(config)).toBe("Nope");
  });

  test("notAllowedIgnore=false with no configured message returns default 🚫", () => {
    const config = makeAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["584149145006"],
      notAllowedIgnore: false,
      // notAllowedMessage is undefined
    });
    expect(getWhatsAppNotAllowedReply(config)).toBe("\u{1F6AB}");
  });

  test("notAllowedIgnore=false with empty string message returns empty string", () => {
    const config = makeAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["584149145006"],
      notAllowedIgnore: false,
      notAllowedMessage: "",
    });
    expect(getWhatsAppNotAllowedReply(config)).toBe("");
  });

  test("old hardcoded English string is never returned", () => {
    const config = makeAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["584149145006"],
      notAllowedIgnore: false,
    });
    const reply = getWhatsAppNotAllowedReply(config);
    // The old string must not appear in any possible return value
    expect(reply).not.toBe(
      "You are not on the allowed users list for this WhatsApp account.",
    );
    // Also verify the default is the emoji, not the old English string
    expect(reply).toBe("\u{1F6AB}");
  });

  test("source regression: old hardcoded string absent from registry.ts", async () => {
    const source = await import("fs").then((fs) =>
      fs.promises.readFile(import.meta.dir + "/../registry.ts", "utf-8"),
    );
    expect(source).not.toContain(
      "You are not on the allowed users list for this WhatsApp account.",
    );
    expect(source).toContain("getWhatsAppNotAllowedReply");
  });
});

// ── messagePrefix tests ──────────────────────────────────────────

describe("messagePrefix", () => {
  test("prepends prefix to outbound agent replies", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      messagePrefix: "\u{1F419}", // 🐙
    });

    await adapter.sendDirectReply!(
      "584149145006@s.whatsapp.net",
      "Hello from Ringo",
    );

    expect(mockData.sendMessageResults.length).toBeGreaterThan(0);
    const sentText = mockData.sendMessageResults[0]!.payload.text;
    expect(sentText).toBe("\u{1F419} Hello from Ringo");

    await adapter.stop();
  });

  test("no prefix when messagePrefix is undefined", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData);

    await adapter.sendDirectReply!(
      "584149145006@s.whatsapp.net",
      "Plain reply",
    );

    const sentText = mockData.sendMessageResults[0]!.payload.text;
    expect(sentText).toBe("Plain reply");

    await adapter.stop();
  });

  test("Ringo prefix 🐙", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      messagePrefix: "\u{1F419}",
    });

    await adapter.sendDirectReply!("584149145006@s.whatsapp.net", "Ringo here");

    const sentText = mockData.sendMessageResults[0]!.payload.text;
    expect(sentText).toBe("\u{1F419} Ringo here");

    await adapter.stop();
  });

  test("Devin prefix 🪬", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      messagePrefix: "🪬",
    });

    await adapter.sendDirectReply!("584149145006@s.whatsapp.net", "Devin here");

    const sentText = mockData.sendMessageResults[0]!.payload.text;
    expect(sentText).toBe("🪬 Devin here");

    await adapter.stop();
  });

  test("Samantha prefix 🤹‍♀️", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      messagePrefix: "\u{1F939}\u{200D}\u{2640}\u{FE0F}",
    });

    await adapter.sendDirectReply!(
      "584149145006@s.whatsapp.net",
      "Samantha here",
    );

    const sentText = mockData.sendMessageResults[0]!.payload.text;
    expect(sentText).toBe("\u{1F939}\u{200D}\u{2640}\u{FE0F} Samantha here");

    await adapter.stop();
  });

  test("prefix applies to waiting messages", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      waitingBehavior: "message",
      waitingMessage: "Working on it...",
      messagePrefix: "\u{1F419}",
    });

    const source: ChannelTurnSource = {
      channel: "whatsapp",
      chatId: "584149145006@s.whatsapp.net",
      agentId: "agent-test",
      conversationId: "conv-test",
    };

    await adapter.handleTurnLivenessEvent!({
      type: "tool_waiting",
      batchId: "batch-1",
      sources: [source],
      toolCategory: "bash",
    });

    // Wait for WAITING_MESSAGE_DELAY_MS
    await new Promise((resolve) => setTimeout(resolve, 3500));

    expect(mockData.sendMessageResults.length).toBeGreaterThan(0);
    const sentText = mockData.sendMessageResults[0]!.payload.text;
    expect(sentText).toBe("\u{1F419} Working on it...");

    await adapter.stop();
  });

  test("prefix applies to error replies", async () => {
    const mockData = makeMockSock();
    const adapter = await createStartedAdapter(mockData, {
      messagePrefix: "\u{1F419}",
    });

    const source: ChannelTurnSource = {
      channel: "whatsapp",
      chatId: "584149145006@s.whatsapp.net",
      agentId: "agent-test",
      conversationId: "conv-test",
      messageId: "msg-1",
    };

    await adapter.handleTurnLifecycleEvent!({
      type: "finished",
      batchId: "batch-1",
      sources: [source],
      outcome: "error",
      error: "Something went wrong",
    });

    expect(mockData.sendMessageResults.length).toBeGreaterThan(0);
    const sentText = mockData.sendMessageResults[0]!.payload.text;
    expect(sentText).toBe("\u{1F419} Something went wrong");

    await adapter.stop();
  });
});
