import { describe, expect, test } from "bun:test";
import { allowedUsersIncludes } from "./jid";

describe("allowedUsersIncludes", () => {
  describe("wildcard semantics", () => {
    test("[] denies all", () => {
      expect(allowedUsersIncludes([], "34600216777")).toBe(false);
    });

    test('["*"] allows all', () => {
      expect(allowedUsersIncludes(["*"], "34600216777")).toBe(true);
      expect(allowedUsersIncludes(["*"], "210565536456917@lid")).toBe(true);
      expect(allowedUsersIncludes(["*"], "anyone")).toBe(true);
    });
  });

  describe("exact match (LID support)", () => {
    test("exact LID string match", () => {
      expect(
        allowedUsersIncludes(["210565536456917@lid"], "210565536456917@lid"),
      ).toBe(true);
    });

    test("exact LID mismatch", () => {
      expect(
        allowedUsersIncludes(["999999999999999@lid"], "210565536456917@lid"),
      ).toBe(false);
    });
  });

  describe("phone normalization", () => {
    test("+34600216777 matches senderId 34600216777", () => {
      expect(
        allowedUsersIncludes(["+34600216777"], "34600216777"),
      ).toBe(true);
    });

    test("34600216777 matches senderId +34600216777", () => {
      expect(
        allowedUsersIncludes(["34600216777"], "+34600216777"),
      ).toBe(true);
    });

    test("34600216777@s.whatsapp.net matches senderId 34600216777", () => {
      expect(
        allowedUsersIncludes(["34600216777@s.whatsapp.net"], "34600216777"),
      ).toBe(true);
    });
  });

  describe("production config simulation", () => {
    const prodAllowedUsers = ["+34600216777", "+584149145006", "+34625815199"];

    test("Héctor's phone matches", () => {
      expect(allowedUsersIncludes(prodAllowedUsers, "34600216777")).toBe(true);
    });

    test("Mercedes' phone matches", () => {
      expect(allowedUsersIncludes(prodAllowedUsers, "584149145006")).toBe(
        true,
      );
    });

    test("unknown phone denied", () => {
      expect(allowedUsersIncludes(prodAllowedUsers, "1234567890")).toBe(false);
    });

    test("LID not in allowlist denied (no exact match)", () => {
      expect(
        allowedUsersIncludes(prodAllowedUsers, "210565536456917@lid"),
      ).toBe(false);
    });
  });

  describe("whitespace tolerance", () => {
    test("trimmed entry matches", () => {
      expect(
        allowedUsersIncludes(["  +34600216777  "], "34600216777"),
      ).toBe(true);
    });
  });
});
