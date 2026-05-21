import { describe, expect, test } from "bun:test";
import {
  allowedUsersIncludes,
  isSelfChat,
  normalizeMaybePhoneJid,
  phoneDigitsToJid,
  resolveSendJid,
  stripDeviceSuffix,
} from "@/channels/whatsapp/jid";

describe("WhatsApp JID helpers", () => {
  test("strips device suffixes without changing the canonical JID", () => {
    expect(stripDeviceSuffix("15551234567:13@s.whatsapp.net")).toBe(
      "15551234567@s.whatsapp.net",
    );
    expect(stripDeviceSuffix("12345@g.us")).toBe("12345@g.us");
  });

  test("normalizes phone-like inputs", () => {
    expect(phoneDigitsToJid("+1 (555) 123-4567")).toBe(
      "15551234567@s.whatsapp.net",
    );
    expect(normalizeMaybePhoneJid("15551234567")).toBe(
      "15551234567@s.whatsapp.net",
    );
    expect(normalizeMaybePhoneJid("999@lid")).toBeNull();
  });

  test("detects self chat across phone JID and LID forms", () => {
    expect(
      isSelfChat(
        "15551234567@s.whatsapp.net",
        "15551234567@s.whatsapp.net",
        "abc@lid",
      ),
    ).toBe(true);
    expect(isSelfChat("abc@lid", "15551234567@s.whatsapp.net", "abc@lid")).toBe(
      true,
    );
    expect(
      isSelfChat(
        "other@s.whatsapp.net",
        "15551234567@s.whatsapp.net",
        "abc@lid",
      ),
    ).toBe(false);
  });

  test("matches allowlisted users by digits", () => {
    expect(allowedUsersIncludes(["+1 555 123 4567"], "15551234567")).toBe(true);
    expect(
      allowedUsersIncludes(["15551234567@s.whatsapp.net"], "+15551234567"),
    ).toBe(true);
  });

  test("matches allowlisted users by exact LID string", () => {
    // LID strings match exactly
    expect(
      allowedUsersIncludes(["210565536456917@lid"], "210565536456917@lid"),
    ).toBe(true);
    // Digit normalization also catches bare digits vs LID form
    // because normalizePhoneLike("210565536456917@lid") extracts "210565536456917"
    expect(
      allowedUsersIncludes(["210565536456917@lid"], "210565536456917"),
    ).toBe(true);
    // Allowlist can mix PN and LID entries
    expect(
      allowedUsersIncludes(
        ["34600216777", "210565536456917@lid"],
        "210565536456917@lid",
      ),
    ).toBe(true);
    expect(
      allowedUsersIncludes(
        ["34600216777", "210565536456917@lid"],
        "34600216777",
      ),
    ).toBe(true);
    // Unrelated LID does not match
    expect(allowedUsersIncludes(["999888777@lid"], "210565536456917@lid")).toBe(
      false,
    );
  });

  test("falls back to normalized LID when no phone mapping exists", () => {
    // Unresolvable LID → fall back to the LID itself (Baileys accepts it)
    expect(resolveSendJid({ chatId: "abc@lid" })).toBe("abc@lid");
    // With device suffix stripped
    expect(resolveSendJid({ chatId: "abc:2@lid" })).toBe("abc@lid");
  });

  test("resolves LID to phone JID via lidToJid map", () => {
    expect(
      resolveSendJid({
        chatId: "abc@lid",
        lidToJid: new Map([["abc@lid", "15551234567@s.whatsapp.net"]]),
      }),
    ).toBe("15551234567@s.whatsapp.net");
  });

  test("resolves LID to phone JID via signalRepository.lidMapping (Map)", () => {
    expect(
      resolveSendJid({
        chatId: "abc@lid",
        sock: {
          signalRepository: {
            lidMapping: new Map([["abc@lid", "15551234567@s.whatsapp.net"]]),
          },
        },
      }),
    ).toBe("15551234567@s.whatsapp.net");
  });

  test("resolves LID to phone JID via signalRepository.lidMapping (Record)", () => {
    expect(
      resolveSendJid({
        chatId: "abc@lid",
        sock: {
          signalRepository: {
            lidMapping: { "abc@lid": "15551234567@s.whatsapp.net" },
          },
        },
      }),
    ).toBe("15551234567@s.whatsapp.net");
  });

  test("resolves self-chat LID to phone JID", () => {
    expect(
      resolveSendJid({
        chatId: "abc@lid",
        selfPhoneJid: "15551234567@s.whatsapp.net",
        selfLid: "abc@lid",
      }),
    ).toBe("15551234567@s.whatsapp.net");
  });

  test("passes phone JID through unchanged", () => {
    expect(resolveSendJid({ chatId: "15551234567@s.whatsapp.net" })).toBe(
      "15551234567@s.whatsapp.net",
    );
  });

  test("passes group JID through unchanged", () => {
    expect(resolveSendJid({ chatId: "12345@g.us" })).toBe("12345@g.us");
  });
});
