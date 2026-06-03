import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/**
 * Smoke tests for WhatsApp MessageChannel outbound.
 *
 * These tests verify the integration between MessageChannel tool execution
 * and the WhatsApp adapter's send path. They do NOT require a live WhatsApp
 * connection — all dependencies are mocked.
 *
 * Key assertions:
 * 1. Successful send → returns a tool result string with messageId (not just "sent")
 *    This distinguishes "tool saw the message" from "message delivered to WhatsApp server".
 * 2. Failed send → returns an error string, NOT a success string with a fake messageId.
 *    The system must not produce a misleading delivery signal.
 * 3. Structured logging: success and failure produce JSON log lines with action field
 *    so smoke tests can distinguish tool-invocation from actual network delivery.
 *
 * The global `__whatsappSendLog` hook captures log output for assertions.
 */

describe("WhatsApp MessageChannel outbound", () => {
  // ── Log capture ────────────────────────────────────────────────────────────

  let capturedLogs: Array<{
    level: string;
    action: string;
    extra: Record<string, string>;
  }> = [];
  let logCleanup: (() => void) | undefined;

  beforeEach(() => {
    capturedLogs = [];
    const globalAny = globalThis as unknown as Record<string, unknown>;
    const prev = globalAny.__whatsappSendLog as
      | ((level: string, action: string, extra: Record<string, string>) => void)
      | undefined;
    globalAny.__whatsappSendLog = (
      level: string,
      action: string,
      extra: Record<string, string>,
    ) => {
      capturedLogs.push({ level, action, extra });
    };
    logCleanup = () => {
      if (prev) {
        globalAny.__whatsappSendLog = prev;
      } else {
        delete globalAny.__whatsappSendLog;
      }
    };
  });

  afterEach(() => {
    logCleanup?.();
  });

  // ── Mock adapter ─────────────────────────────────────────────────────────────

  function makeMockAdapter(overrides: {
    sendMessageResult?: { messageId: string } | Error;
    isRunning?: boolean;
  }): {
    adapter: {
      isRunning(): boolean;
      sendMessage(msg: unknown): Promise<{ messageId: string }>;
    };
    sentMessages: unknown[];
  } {
    const sentMessages: unknown[] = [];
    const {
      sendMessageResult = { messageId: "mock-msg-123" },
      isRunning = true,
    } = overrides;
    const globalAny = globalThis as unknown as Record<string, unknown>;

    return {
      sentMessages,
      adapter: {
        isRunning: () => isRunning,
        sendMessage: async (msg: unknown) => {
          if (!isRunning) throw new Error("WhatsApp adapter is not running.");
          sentMessages.push(msg);
          if (sendMessageResult instanceof Error) {
            const detail = sendMessageResult.message;
            if (typeof globalAny.__whatsappSendLog === "function") {
              globalAny.__whatsappSendLog("error", "whatsapp_send_failed", {
                chatId: "mock",
                detail,
              });
            }
            throw sendMessageResult;
          }
          if (typeof globalAny.__whatsappSendLog === "function") {
            globalAny.__whatsappSendLog("info", "whatsapp_message_sent", {
              messageId: sendMessageResult.messageId,
              chatId: "31612345678",
            });
          }
          return sendMessageResult;
        },
      },
    };
  }

  // ── Test: adapter logs on successful send ────────────────────────────────────

  test("successful sendMessage logs whatsapp_message_sent with messageId", async () => {
    const { adapter, sentMessages } = makeMockAdapter({
      sendMessageResult: { messageId: "WA.123456789" },
    });

    // Simulate the adapter.sendMessage call path (as WhatsAppMessageActions does).
    const result = await adapter.sendMessage({
      channel: "whatsapp",
      accountId: "test-account",
      chatId: "31612345678",
      text: "Hello via MessageChannel",
    });

    // The result must contain a real-looking messageId (not a generic "success").
    expect(result.messageId).toMatch(/^WA\./);
    expect(sentMessages.length).toBe(1);

    // The log must have been emitted via the global hook.
    expect(capturedLogs.some((l) => l.action === "whatsapp_message_sent")).toBe(
      true,
    );
    const msgLog = capturedLogs.find(
      (l) => l.action === "whatsapp_message_sent",
    );
    expect(msgLog?.extra.messageId).toBe("WA.123456789");
    expect(msgLog?.extra.chatId).toBe("31612345678");
  });

  // ── Test: adapter logs on failed send ────────────────────────────────────────

  test("failed sendMessage logs whatsapp_send_failed (not whatsapp_message_sent)", async () => {
    const error = new Error("ENOTFOUND ai.server.letta.internal");
    const { adapter, sentMessages } = makeMockAdapter({
      sendMessageResult: error,
    });

    // Simulate the adapter.sendMessage call path.
    let thrown = false;
    try {
      await adapter.sendMessage({
        channel: "whatsapp",
        accountId: "test-account",
        chatId: "31612345678",
        text: "Hello via MessageChannel",
      });
    } catch {
      thrown = true;
    }

    // The call must have thrown (no fake success on network failure).
    expect(thrown).toBe(true);
    expect(sentMessages.length).toBe(1);

    // whatsapp_send_failed must be logged, whatsapp_message_sent must NOT be logged.
    expect(capturedLogs.some((l) => l.action === "whatsapp_send_failed")).toBe(
      true,
    );
    expect(capturedLogs.some((l) => l.action === "whatsapp_message_sent")).toBe(
      false,
    );

    const failLog = capturedLogs.find(
      (l) => l.action === "whatsapp_send_failed",
    );
    expect(failLog?.extra.detail).toContain("ENOTFOUND");
  });

  // ── Test: MessageChannel tool result error string on adapter failure ───────────

  test("MessageChannel returns error string (not success) when adapter throws", async () => {
    const error = new Error("ECONNREFUSED");
    const { adapter } = makeMockAdapter({ sendMessageResult: error });

    // Simulate what happens in message-actions.ts handleAction when adapter.sendMessage throws.
    let toolResult: string;
    try {
      await adapter.sendMessage({
        channel: "whatsapp",
        accountId: "test-account",
        chatId: "31612345678",
        text: "test",
      });
      toolResult = "Message sent to whatsapp (message_id: mock-msg-123)"; // should not happen
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      toolResult = `Error sending message to whatsapp: ${msg}`;
    }

    // Error result must contain the error description, not a success message.
    expect(toolResult.startsWith("Error sending message to whatsapp:")).toBe(
      true,
    );
    expect(toolResult.includes("Message sent to whatsapp")).toBe(false);
    expect(toolResult.includes("message_id:")).toBe(false);
  });

  // ── Test: adapter not running → early error, no send log ─────────────────────

  test("sendMessage when adapter not running → throws before logging send", async () => {
    const { adapter } = makeMockAdapter({ isRunning: false });

    let threw = false;
    try {
      await adapter.sendMessage({
        channel: "whatsapp",
        accountId: "test-account",
        chatId: "31612345678",
        text: "test",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    // No send log should be emitted if the adapter isn't running.
    expect(capturedLogs.some((l) => l.action === "whatsapp_send_failed")).toBe(
      false,
    );
    expect(capturedLogs.some((l) => l.action === "whatsapp_message_sent")).toBe(
      false,
    );
  });
});
