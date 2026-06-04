import { describe, expect, test } from "bun:test";
import {
  matchesWildcardList,
  normalizeWildcardList,
} from "@/channels/wildcardList";

describe("normalizeWildcardList", () => {
  test("undefined normalizes to empty array (deny all)", () => {
    expect(normalizeWildcardList(undefined)).toEqual([]);
  });

  test("empty array stays empty (deny all)", () => {
    expect(normalizeWildcardList([])).toEqual([]);
  });

  test("single wildcard stays as-is", () => {
    expect(normalizeWildcardList(["*"])).toEqual(["*"]);
  });

  test("trims whitespace from entries", () => {
    expect(normalizeWildcardList(["  foo ", " bar  "])).toEqual(["foo", "bar"]);
  });

  test("deduplicates entries", () => {
    expect(normalizeWildcardList(["foo", "bar", "foo", "baz"])).toEqual([
      "foo",
      "bar",
      "baz",
    ]);
  });

  test("collapses multiple wildcards to single", () => {
    expect(normalizeWildcardList(["*", "foo", "*"])).toEqual(["*"]);
  });

  test("drops empty strings after trim", () => {
    expect(normalizeWildcardList(["", "  ", "foo"])).toEqual(["foo"]);
  });

  test("wildcard present collapses to single wildcard", () => {
    expect(normalizeWildcardList(["foo", "*", "bar"])).toEqual(["*"]);
  });
});

describe("matchesWildcardList", () => {
  test("empty list denies all", () => {
    expect(matchesWildcardList([], "anything")).toBe(false);
  });

  test("single wildcard allows all", () => {
    expect(matchesWildcardList(["*"], "anything")).toBe(true);
  });

  test("exact match in list", () => {
    expect(matchesWildcardList(["foo", "bar"], "foo")).toBe(true);
    expect(matchesWildcardList(["foo", "bar"], "baz")).toBe(false);
  });

  test("whitespace-insensitive match after normalization", () => {
    // matchesWildcardList expects pre-normalized lists; normalize first
    const normalized = normalizeWildcardList(["  foo  "]);
    expect(matchesWildcardList(normalized, "foo")).toBe(true);
  });

  test("empty string does not match empty list", () => {
    expect(matchesWildcardList([], "")).toBe(false);
  });

  test("empty string matches wildcard", () => {
    expect(matchesWildcardList(["*"], "")).toBe(true);
  });
});

describe("Slack/Discord regression proof: .includes() vs matchesWildcardList", () => {
  test("['*'] does NOT allow all with .includes() (Slack/Discord behavior)", () => {
    // Slack and Discord use config.allowedUsers.includes(senderId)
    // A literal "*" entry only matches a user literally named "*"
    const allowedUsers = ["*"];
    expect(allowedUsers.includes("anyone@example.com")).toBe(false);
    expect(allowedUsers.includes("*")).toBe(true);
  });

  test("['*'] DOES allow all with matchesWildcardList (WhatsApp behavior)", () => {
    // WhatsApp uses matchesWildcardList which treats ["*"] as wildcard
    expect(matchesWildcardList(["*"], "anyone@example.com")).toBe(true);
  });

  test("[] denies all with both .includes() and matchesWildcardList", () => {
    // Both mechanisms deny all for empty arrays — no semantic difference here
    const empty: string[] = [];
    expect(empty.includes("anyone@example.com")).toBe(false);
    expect(matchesWildcardList([], "anyone@example.com")).toBe(false);
  });
});

describe("WhatsApp fail-closed semantics proof", () => {
  test("undefined denies all (normalized to [] at load time)", () => {
    const normalized = normalizeWildcardList(undefined);
    expect(normalized).toEqual([]);
    expect(matchesWildcardList(normalized, "anyone")).toBe(false);
  });

  test("[] denies all", () => {
    expect(matchesWildcardList([], "anyone")).toBe(false);
  });

  test("['*'] allows all", () => {
    expect(matchesWildcardList(["*"], "anyone")).toBe(true);
  });

  test("explicit list is allowlist", () => {
    const list = ["user1", "user2"];
    expect(matchesWildcardList(list, "user1")).toBe(true);
    expect(matchesWildcardList(list, "user3")).toBe(false);
  });
});

describe("Attachment send-time enforcement proof", () => {
  test("attachmentMimeTypes [] blocks all MIME types", () => {
    expect(matchesWildcardList([], "image/png")).toBe(false);
    expect(matchesWildcardList([], "video/mp4")).toBe(false);
    expect(matchesWildcardList([], "application/pdf")).toBe(false);
  });

  test("attachmentMimeTypes ['*'] allows all MIME types", () => {
    expect(matchesWildcardList(["*"], "image/png")).toBe(true);
    expect(matchesWildcardList(["*"], "video/mp4")).toBe(true);
  });

  test("attachmentMimeTypes explicit list is strict allowlist", () => {
    const mimes = ["image/png", "image/jpeg"];
    expect(matchesWildcardList(mimes, "image/png")).toBe(true);
    expect(matchesWildcardList(mimes, "image/jpeg")).toBe(true);
    expect(matchesWildcardList(mimes, "video/mp4")).toBe(false);
    expect(matchesWildcardList(mimes, "application/pdf")).toBe(false);
  });

  test("attachmentAllowedRecipients [] blocks all recipients", () => {
    expect(matchesWildcardList([], "12345@g.us")).toBe(false);
    expect(matchesWildcardList([], "user@s.whatsapp.net")).toBe(false);
  });

  test("attachmentAllowedRecipients ['*'] allows all recipients", () => {
    expect(matchesWildcardList(["*"], "12345@g.us")).toBe(true);
    expect(matchesWildcardList(["*"], "user@s.whatsapp.net")).toBe(true);
  });

  test("attachmentAllowedRecipients explicit list is strict allowlist", () => {
    const recipients = ["12345@g.us"];
    expect(matchesWildcardList(recipients, "12345@g.us")).toBe(true);
    expect(matchesWildcardList(recipients, "99999@g.us")).toBe(false);
  });
});
