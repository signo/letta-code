/**
 * Tests for baileysCompat.ts — LID mapping lookup across Baileys versions.
 *
 * Covers all four observed lidMapping shapes:
 * - v6 Map<string, string>
 * - v6 plain Record<string, string>
 * - v6 object with .get() method
 * - v7 object with getPNForLID() method
 */
import { describe, expect, test } from "bun:test";

import { lookupLidMapping } from "./baileysCompat";

function makeSocket(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lidMapping: any,
) {
  return { signalRepository: { lidMapping } } as Parameters<
    typeof lookupLidMapping
  >[0];
}

describe("lookupLidMapping", () => {
  describe("v6: Map<string, string>", () => {
    test("returns the mapped value when key exists", () => {
      const sock = makeSocket(new Map([["210565536456917", "34600216777@s.whatsapp.net"]]));
      expect(lookupLidMapping(sock, "210565536456917")).toBe(
        "34600216777@s.whatsapp.net",
      );
    });

    test("returns undefined when key is absent", () => {
      const sock = makeSocket(new Map([["other-lid", "34600216777@s.whatsapp.net"]]));
      expect(lookupLidMapping(sock, "210565536456917")).toBeUndefined();
    });

    test("returns undefined for empty Map", () => {
      const sock = makeSocket(new Map());
      expect(lookupLidMapping(sock, "210565536456917")).toBeUndefined();
    });

    test("returns undefined when Map value is not a string", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sock = makeSocket(new Map<any, any>([["lid", 42]]));
      expect(lookupLidMapping(sock, "lid")).toBeUndefined();
    });
  });

  describe("v6: plain Record<string, string>", () => {
    test("returns the mapped value when key exists", () => {
      const sock = makeSocket({
        "210565536456917": "34600216777@s.whatsapp.net",
      });
      expect(lookupLidMapping(sock, "210565536456917")).toBe(
        "34600216777@s.whatsapp.net",
      );
    });

    test("returns undefined when key is absent", () => {
      const sock = makeSocket({ "other-lid": "34600216777@s.whatsapp.net" });
      expect(lookupLidMapping(sock, "210565536456917")).toBeUndefined();
    });

    test("returns undefined when Record value is not a string", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sock = makeSocket({ lid: 42 } as any);
      expect(lookupLidMapping(sock, "lid")).toBeUndefined();
    });

    test("returns undefined for empty Record", () => {
      const sock = makeSocket({});
      expect(lookupLidMapping(sock, "210565536456917")).toBeUndefined();
    });
  });

  describe("v6: object with .get() method", () => {
    test("returns the mapped value when key exists", () => {
      const store = new Map([["210565536456917", "34600216777@s.whatsapp.net"]]);
      const sock = makeProxy(store);

      function makeProxy(map: Map<string, string>) {
        return {
          signalRepository: {
            lidMapping: {
              get: (key: string) => map.get(key),
            },
          },
        };
      }

      expect(lookupLidMapping(sock, "210565536456917")).toBe(
        "34600216777@s.whatsapp.net",
      );
    });

    test("returns undefined when key is absent", () => {
      const sock = makeSocket({
        get: (_key: string) => undefined,
      });
      expect(lookupLidMapping(sock, "210565536456917")).toBeUndefined();
    });

    test("returns undefined when .get() returns non-string", () => {
      const sock = makeSocket({
        get: (_key: string) => 42,
      });
      expect(lookupLidMapping(sock, "lid")).toBeUndefined();
    });
  });

  describe("v7: getPNForLID() method", () => {
    test("returns the mapped value when key exists", () => {
      const sock = {
        signalRepository: {
          lidMapping: {
            getPNForLID: (lid: string) => {
              if (lid === "210565536456917")
                return "34600216777@s.whatsapp.net";
              return undefined;
            },
          },
        },
      };
      expect(lookupLidMapping(sock, "210565536456917")).toBe(
        "34600216777@s.whatsapp.net",
      );
    });

    test("returns undefined when key is absent", () => {
      const sock = {
        signalRepository: {
          lidMapping: {
            getPNForLID: (_lid: string) => undefined,
          },
        },
      };
      expect(lookupLidMapping(sock, "210565536456917")).toBeUndefined();
    });

    test("returns undefined when getPNForLID returns non-string", () => {
      const sock = {
        signalRepository: {
          lidMapping: {
            getPNForLID: (_lid: string) => 42,
          },
        },
      };
      expect(lookupLidMapping(sock, "lid")).toBeUndefined();
    });

    test("getPNForLID takes priority over Map", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sock: any = {
        signalRepository: {
          lidMapping: {
            getPNForLID: (lid: string) =>
              lid === "210565536456917" ? "v7-phone@s.whatsapp.net" : undefined,
            // Map with conflicting entry
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        },
      };
      // sock.signalRepository.lidMapping is both getPNForLID and a Map-like
      const combined = {
        getPNForLID: (lid: string) =>
          lid === "210565536456917" ? "v7-phone@s.whatsapp.net" : undefined,
      };
      expect(lookupLidMapping({ signalRepository: { lidMapping: combined } }, "210565536456917")).toBe(
        "v7-phone@s.whatsapp.net",
      );
    });
  });

  describe("null/undefined guard", () => {
    test("returns undefined when sock is null", () => {
      expect(lookupLidMapping(null as any, "210565536456917")).toBeUndefined();
    });

    test("returns undefined when sock is undefined", () => {
      expect(lookupLidMapping(undefined as any, "210565536456917")).toBeUndefined();
    });

    test("returns undefined when signalRepository is absent", () => {
      expect(lookupLidMapping({} as any, "210565536456917")).toBeUndefined();
    });

    test("returns undefined when lidMapping is absent", () => {
      expect(
        lookupLidMapping({ signalRepository: {} } as any, "210565536456917"),
      ).toBeUndefined();
    });
  });
});
