import { describe, expect, test } from "bun:test";
import { lookupLidMapping } from "@/channels/whatsapp/baileysCompat";

describe("lookupLidMapping (Baileys compat boundary)", () => {
  const lidKey = "210565536456917@lid";
  const phoneJid = "15551234567@s.whatsapp.net";

  test("returns undefined when sock is null", () => {
    expect(lookupLidMapping(null, lidKey)).toBeUndefined();
  });

  test("returns undefined when sock is undefined", () => {
    expect(lookupLidMapping(undefined, lidKey)).toBeUndefined();
  });

  test("returns undefined when signalRepository is missing", () => {
    expect(lookupLidMapping({}, lidKey)).toBeUndefined();
  });

  test("returns undefined when lidMapping is missing", () => {
    expect(
      lookupLidMapping({ signalRepository: {} }, lidKey),
    ).toBeUndefined();
  });

  test("resolves via Map instance", () => {
    const sock = {
      signalRepository: {
        lidMapping: new Map([[lidKey, phoneJid]]),
      },
    };
    expect(lookupLidMapping(sock, lidKey)).toBe(phoneJid);
  });

  test("resolves via plain Record/object", () => {
    const sock = {
      signalRepository: {
        lidMapping: { [lidKey]: phoneJid } as Record<string, string>,
      },
    };
    expect(lookupLidMapping(sock, lidKey)).toBe(phoneJid);
  });

  test("resolves via object with .get() method", () => {
    const sock = {
      signalRepository: {
        lidMapping: {
          get: (key: string) =>
            key === lidKey ? phoneJid : undefined,
        },
      },
    };
    expect(lookupLidMapping(sock, lidKey)).toBe(phoneJid);
  });

  test("resolves via v7-style getPNForLID() method", () => {
    const sock = {
      signalRepository: {
        lidMapping: {
          getPNForLID: (lid: string) =>
            lid === lidKey ? phoneJid : undefined,
        },
      },
    };
    expect(lookupLidMapping(sock, lidKey)).toBe(phoneJid);
  });

  test("returns undefined for missing key in Map", () => {
    const sock = {
      signalRepository: {
        lidMapping: new Map([["other@lid", phoneJid]]),
      },
    };
    expect(lookupLidMapping(sock, lidKey)).toBeUndefined();
  });

  test("returns undefined for missing key in Record", () => {
    const sock = {
      signalRepository: {
        lidMapping: { "other@lid": phoneJid },
      },
    };
    expect(lookupLidMapping(sock, lidKey)).toBeUndefined();
  });

  test("getPNForLID takes priority over .get() when both exist", () => {
    const v7Value = "v7-phone@s.whatsapp.net";
    const sock = {
      signalRepository: {
        lidMapping: {
          getPNForLID: () => v7Value,
          get: () => "old-phone@s.whatsapp.net",
        },
      },
    };
    expect(lookupLidMapping(sock, lidKey)).toBe(v7Value);
  });

  test("falls back when getPNForLID returns a non-string value", () => {
    const sock = {
      signalRepository: {
        lidMapping: {
          getPNForLID: () => ({ jid: phoneJid }),
          get: (key: string) =>
            key === lidKey ? phoneJid : undefined,
        },
      },
    };
    expect(lookupLidMapping(sock, lidKey)).toBe(phoneJid);
  });

  test("returns undefined when all mapping shapes return non-string values", () => {
    const sock = {
      signalRepository: {
        lidMapping: {
          getPNForLID: () => Promise.resolve(phoneJid),
        },
      },
    };
    expect(lookupLidMapping(sock, lidKey)).toBeUndefined();
  });

  test("falls through to Record access when .get() is not a function", () => {
    const sock = {
      signalRepository: {
        lidMapping: {
          get: "not a function",
          [lidKey]: phoneJid,
        },
      },
    };
    expect(lookupLidMapping(sock, lidKey)).toBe(phoneJid);
  });
});
