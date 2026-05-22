import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearWhatsAppConnectionState,
  getWhatsAppConnectionState,
  setWhatsAppConnectionState,
  subscribeWhatsAppConnectionState,
  toWhatsAppConnectionConfig,
} from "@/channels/whatsapp/state";

const ACCOUNT = "test-account";

describe("whatsapp/state diagnostics", () => {
  beforeEach(() => {
    clearWhatsAppConnectionState(ACCOUNT);
  });

  test("default state is backward compatible", () => {
    const state = getWhatsAppConnectionState(ACCOUNT);
    expect(state.status).toBe("idle");
    expect(state.lastErrorAt).toBeUndefined();
    expect(state.lastInbound).toBeUndefined();
    expect(state.lastOutbound).toBeUndefined();
  });

  test("persists diagnostics fields", () => {
    const ts = "2026-05-22T10:00:00.000Z";
    const next = setWhatsAppConnectionState(ACCOUNT, {
      status: "error",
      lastError: "timeout",
      lastErrorAt: ts,
      lastInbound: { chatId: "c1@lid", messageId: "m1", timestamp: 1000 },
      lastOutbound: { chatId: "c2@s.whatsapp.net", timestamp: 2000 },
    });

    expect(next.lastErrorAt).toBe(ts);
    expect(next.lastInbound?.chatId).toBe("c1@lid");
    expect(next.lastInbound?.messageId).toBe("m1");
    expect(next.lastOutbound?.chatId).toBe("c2@s.whatsapp.net");
    expect(next.lastOutbound?.messageId).toBeUndefined();
  });

  test("serializes diagnostics to snake_case", () => {
    setWhatsAppConnectionState(ACCOUNT, {
      status: "connected",
      lastErrorAt: "2026-05-22T10:00:00.000Z",
      lastInbound: { chatId: "a@lid", messageId: "in-1", timestamp: 123 },
      lastOutbound: { chatId: "b@s.whatsapp.net", timestamp: 456 },
    });

    const cfg = toWhatsAppConnectionConfig(ACCOUNT);
    expect(cfg.last_error_at).toBe("2026-05-22T10:00:00.000Z");
    expect(cfg.last_inbound).toEqual({
      chat_id: "a@lid",
      message_id: "in-1",
      timestamp: 123,
    });
    expect(cfg.last_outbound).toEqual({
      chat_id: "b@s.whatsapp.net",
      timestamp: 456,
    });
  });

  test("listener receives diagnostics fields", () => {
    const seen: Array<ReturnType<typeof getWhatsAppConnectionState>> = [];
    const unsub = subscribeWhatsAppConnectionState((_id, state) => {
      seen.push(state);
    });

    setWhatsAppConnectionState(ACCOUNT, {
      status: "connected",
      lastInbound: { chatId: "x@lid", timestamp: 42 },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.lastInbound?.chatId).toBe("x@lid");
    unsub();
  });
});
