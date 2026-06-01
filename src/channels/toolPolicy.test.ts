import { describe, expect, test } from "bun:test";
import type { ToolPolicy } from "./toolPolicy";
import { evaluateToolPolicy, formatToolPolicyDenial } from "./toolPolicy";

describe("evaluateToolPolicy", () => {
  // ── allowedTools semantics ──────────────────────────────────────────

  test("undefined allowedTools => allow all (default)", () => {
    const policy: ToolPolicy = {};
    expect(evaluateToolPolicy("Bash", policy)).toBe("allow");
    expect(evaluateToolPolicy("Read", policy)).toBe("allow");
    expect(evaluateToolPolicy("MessageChannel", policy)).toBe("allow");
  });

  test('["*"] allowedTools => allow all', () => {
    const policy: ToolPolicy = { allowedTools: ["*"] };
    expect(evaluateToolPolicy("Bash", policy)).toBe("allow");
    expect(evaluateToolPolicy("Write", policy)).toBe("allow");
  });

  test("[] allowedTools => deny all", () => {
    const policy: ToolPolicy = { allowedTools: [] };
    expect(evaluateToolPolicy("Bash", policy)).toBe("deny");
    expect(evaluateToolPolicy("Read", policy)).toBe("deny");
  });

  test("explicit allowedTools => allowlist", () => {
    const policy: ToolPolicy = { allowedTools: ["Bash", "Read"] };
    expect(evaluateToolPolicy("Bash", policy)).toBe("allow");
    expect(evaluateToolPolicy("Read", policy)).toBe("allow");
    expect(evaluateToolPolicy("Write", policy)).toBe("deny");
    expect(evaluateToolPolicy("MessageChannel", policy)).toBe("deny");
  });

  // ── blockedTools semantics ──────────────────────────────────────────

  test("undefined blockedTools => no blocking", () => {
    const policy: ToolPolicy = { allowedTools: ["*"] };
    expect(evaluateToolPolicy("Bash", policy)).toBe("allow");
  });

  test("[] blockedTools => no blocking", () => {
    const policy: ToolPolicy = { allowedTools: ["*"], blockedTools: [] };
    expect(evaluateToolPolicy("Bash", policy)).toBe("allow");
  });

  test("blockedTools subtracts from allowed set", () => {
    const policy: ToolPolicy = {
      allowedTools: ["*"],
      blockedTools: ["Bash", "Write"],
    };
    expect(evaluateToolPolicy("Bash", policy)).toBe("deny");
    expect(evaluateToolPolicy("Write", policy)).toBe("deny");
    expect(evaluateToolPolicy("Read", policy)).toBe("allow");
  });

  test("blockedTools with explicit allowedTools", () => {
    const policy: ToolPolicy = {
      allowedTools: ["Bash", "Read", "Write"],
      blockedTools: ["Write"],
    };
    expect(evaluateToolPolicy("Bash", policy)).toBe("allow");
    expect(evaluateToolPolicy("Read", policy)).toBe("allow");
    expect(evaluateToolPolicy("Write", policy)).toBe("deny");
    expect(evaluateToolPolicy("Edit", policy)).toBe("deny");
  });

  test('blockedTools ["*"] blocks everything', () => {
    const policy: ToolPolicy = {
      allowedTools: ["*"],
      blockedTools: ["*"],
    };
    expect(evaluateToolPolicy("Bash", policy)).toBe("deny");
    expect(evaluateToolPolicy("Read", policy)).toBe("deny");
  });

  // ── combined edge cases ─────────────────────────────────────────────

  test("blockedTools checked before allowedTools (fast-path deny)", () => {
    const policy: ToolPolicy = {
      allowedTools: ["*"],
      blockedTools: ["Bash"],
    };
    expect(evaluateToolPolicy("Bash", policy)).toBe("deny");
  });

  test("empty policy (both undefined) => allow all", () => {
    const policy: ToolPolicy = {};
    expect(evaluateToolPolicy("Bash", policy)).toBe("allow");
    expect(evaluateToolPolicy("Read", policy)).toBe("allow");
    expect(evaluateToolPolicy("Write", policy)).toBe("allow");
  });

  test("whitespace in allowedTools is trimmed by normalization", () => {
    const policy: ToolPolicy = { allowedTools: [" Bash ", "  Read  "] };
    expect(evaluateToolPolicy("Bash", policy)).toBe("allow");
    expect(evaluateToolPolicy("Read", policy)).toBe("allow");
    expect(evaluateToolPolicy("Write", policy)).toBe("deny");
  });

  test("duplicate collapse in allowedTools", () => {
    const policy: ToolPolicy = {
      allowedTools: ["Bash", "Bash", "Read"],
    };
    expect(evaluateToolPolicy("Bash", policy)).toBe("allow");
    expect(evaluateToolPolicy("Read", policy)).toBe("allow");
    expect(evaluateToolPolicy("Write", policy)).toBe("deny");
  });

  test("whitespace in blockedTools is trimmed by normalization", () => {
    const policy: ToolPolicy = {
      allowedTools: ["*"],
      blockedTools: [" Bash "],
    };
    expect(evaluateToolPolicy("Bash", policy)).toBe("deny");
    expect(evaluateToolPolicy("Read", policy)).toBe("allow");
  });
});

describe("formatToolPolicyDenial", () => {
  test("returns user-visible denial message", () => {
    const message = formatToolPolicyDenial("Bash");
    expect(message).toContain("Bash");
    expect(message).toContain("not permitted");
    expect(message).not.toContain("approval");
    expect(message).not.toContain("stack");
  });

  test("includes tool name for action guidance", () => {
    const message = formatToolPolicyDenial("Write");
    expect(message).toContain("Write");
  });
});