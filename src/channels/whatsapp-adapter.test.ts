import { describe, expect, test } from "bun:test";
import {
  buildWhatsAppReadReceiptKeys,
  isWhatsAppConflictDisconnect,
  shouldMarkWhatsAppReadReceipt,
} from "@/channels/whatsapp/adapter";

describe("WhatsApp adapter helpers", () => {
  test("detects session conflict disconnects by message", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { message: "Stream Errored (conflict)" } },
      }),
    ).toBe(true);
  });

  test("detects session conflict disconnects by status code", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 440 } } },
      }),
    ).toBe(true);
  });

  test("ignores non-conflict disconnects", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { message: "timed out" } },
      }),
    ).toBe(false);
  });

  test("marks read for accepted direct messages", () => {
    expect(
      shouldMarkWhatsAppReadReceipt({
        chatType: "direct",
        dmPolicy: "open",
        accepted: true,
      }),
    ).toBe(true);
  });

  test("does not mark read for channel/group messages", () => {
    expect(
      shouldMarkWhatsAppReadReceipt({
        chatType: "channel",
        dmPolicy: "open",
        accepted: true,
      }),
    ).toBe(false);
  });

  test("does not mark read when message was not accepted", () => {
    expect(
      shouldMarkWhatsAppReadReceipt({
        chatType: "direct",
        dmPolicy: "allowlist",
        accepted: false,
      }),
    ).toBe(false);
  });

  test("builds read receipt key with participant when present", () => {
    expect(
      buildWhatsAppReadReceiptKeys({
        remoteJid: "1203@g.us",
        messageId: "abc",
        participant: "5511@s.whatsapp.net",
      }),
    ).toEqual([
      {
        remoteJid: "1203@g.us",
        id: "abc",
        participant: "5511@s.whatsapp.net",
      },
    ]);
  });

  test("builds read receipt key without participant for direct messages", () => {
    expect(
      buildWhatsAppReadReceiptKeys({
        remoteJid: "5511@s.whatsapp.net",
        messageId: "abc",
      }),
    ).toEqual([
      {
        remoteJid: "5511@s.whatsapp.net",
        id: "abc",
      },
    ]);
  });
});
