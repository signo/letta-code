import { describe, expect, test } from "bun:test";
import type { WhatsAppChannelAccount } from "@/channels/types";
import { whatsappAccountConfigAdapter } from "@/channels/whatsapp/account-config";

function makeAccount(
  overrides: Partial<WhatsAppChannelAccount> = {},
): WhatsAppChannelAccount {
  return {
    channel: "whatsapp",
    accountId: "acct-1",
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

// ── waiting_behavior / waiting_message (PR 4) ────────────────────

describe("whatsappAccountConfigAdapter.isValidConfig", () => {
  test("accepts waiting_behavior with valid values", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "off",
      }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "typing_indicator",
      }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "message",
      }),
    ).toBe(true);
  });

  test("accepts waiting_message as string", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_message: "Give me a moment...",
      }),
    ).toBe(true);
  });

  test("rejects invalid waiting_behavior values", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "reaction",
      }),
    ).toBe(false);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: 42,
      }),
    ).toBe(false);
  });

  test("rejects non-string waiting_message", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_message: 123,
      }),
    ).toBe(false);
  });

  test("accepts config without waiting fields", () => {
    expect(whatsappAccountConfigAdapter.isValidConfig({})).toBe(true);
  });

  test("rejects unknown keys", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "off",
        unknown_field: "x",
      }),
    ).toBe(false);
  });

  // ── not_allowed fields (PR 5) ────────────────────────────────

  test("accepts not_allowed_ignore as boolean", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        not_allowed_ignore: true,
      }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        not_allowed_ignore: false,
      }),
    ).toBe(true);
  });

  test("accepts not_allowed_message as string", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        not_allowed_message: "Access denied",
      }),
    ).toBe(true);
  });

  test("rejects non-boolean not_allowed_ignore", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        not_allowed_ignore: "yes",
      }),
    ).toBe(false);
  });

  test("rejects non-string not_allowed_message", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        not_allowed_message: 403,
      }),
    ).toBe(false);
  });

  // ── message_prefix (PR 5) ────────────────────────────────────

  test("accepts message_prefix as string", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        message_prefix: "\u{1F419}",
      }),
    ).toBe(true);
  });

  test("rejects non-string message_prefix", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        message_prefix: 42,
      }),
    ).toBe(false);
  });
});

describe("whatsappAccountConfigAdapter.toAccountPatch", () => {
  test("normalizes waiting_behavior to waitingBehavior", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      waiting_behavior: "typing_indicator",
    });
    expect(patch.waitingBehavior).toBe("typing_indicator");
  });

  test("normalizes waiting_message to waitingMessage", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      waiting_message: "I'll be back...",
    });
    expect(patch.waitingMessage).toBe("I'll be back...");
  });

  test("normalizes both fields together", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      waiting_behavior: "message",
      waiting_message: "Working on it...",
    });
    expect(patch.waitingBehavior).toBe("message");
    expect(patch.waitingMessage).toBe("Working on it...");
  });

  test("returns undefined for invalid waiting_behavior", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      waiting_behavior: "reaction",
    });
    expect(patch.waitingBehavior).toBeUndefined();
  });

  test("returns undefined for non-string waiting_message", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      waiting_message: 42,
    });
    expect(patch.waitingMessage).toBeUndefined();
  });

  test("returns undefined when fields are absent", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({});
    expect(patch.waitingBehavior).toBeUndefined();
    expect(patch.waitingMessage).toBeUndefined();
  });

  // ── not_allowed fields (PR 5) ────────────────────────────────

  test("normalizes not_allowed_ignore to notAllowedIgnore", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      not_allowed_ignore: false,
    });
    expect(patch.notAllowedIgnore).toBe(false);
  });

  test("normalizes not_allowed_message to notAllowedMessage", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      not_allowed_message: "Nope",
    });
    expect(patch.notAllowedMessage).toBe("Nope");
  });

  test("returns undefined for invalid not_allowed_ignore", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      not_allowed_ignore: "yes",
    });
    expect(patch.notAllowedIgnore).toBeUndefined();
  });

  test("returns undefined for non-string not_allowed_message", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      not_allowed_message: 42,
    });
    expect(patch.notAllowedMessage).toBeUndefined();
  });

  // ── message_prefix (PR 5) ────────────────────────────────────

  test("normalizes message_prefix to messagePrefix", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      message_prefix: "\u{1F419}",
    });
    expect(patch.messagePrefix).toBe("\u{1F419}");
  });

  test("returns undefined for non-string message_prefix", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      message_prefix: 42,
    });
    expect(patch.messagePrefix).toBeUndefined();
  });

  test("normalizes all PR 5 fields together", () => {
    const patch = whatsappAccountConfigAdapter.toAccountPatch({
      not_allowed_ignore: false,
      not_allowed_message: "Denied",
      message_prefix: "\u{1FAC0}",
    });
    expect(patch.notAllowedIgnore).toBe(false);
    expect(patch.notAllowedMessage).toBe("Denied");
    expect(patch.messagePrefix).toBe("\u{1FAC0}");
  });
});

describe("whatsappAccountConfigAdapter.toAccountConfig", () => {
  test("serializes waiting_behavior and waiting_message to snake_case", () => {
    const account = makeAccount({
      waitingBehavior: "message",
      waitingMessage: "Hold on...",
    });
    const config = whatsappAccountConfigAdapter.toAccountConfig(account);
    expect(config.waiting_behavior).toBe("message");
    expect(config.waiting_message).toBe("Hold on...");
  });

  test("serializes undefined waiting fields", () => {
    const account = makeAccount();
    const config = whatsappAccountConfigAdapter.toAccountConfig(account);
    expect(config.waiting_behavior).toBeUndefined();
    expect(config.waiting_message).toBeUndefined();
  });

  test("serializes not_allowed fields to snake_case", () => {
    const account = makeAccount({
      notAllowedIgnore: false,
      notAllowedMessage: "Access denied",
    });
    const config = whatsappAccountConfigAdapter.toAccountConfig(account);
    expect(config.not_allowed_ignore).toBe(false);
    expect(config.not_allowed_message).toBe("Access denied");
  });

  test("serializes message_prefix to snake_case", () => {
    const account = makeAccount({
      messagePrefix: "\u{1F419}",
    });
    const config = whatsappAccountConfigAdapter.toAccountConfig(account);
    expect(config.message_prefix).toBe("\u{1F419}");
  });

  test("serializes undefined PR 5 fields", () => {
    const account = makeAccount();
    const config = whatsappAccountConfigAdapter.toAccountConfig(account);
    expect(config.not_allowed_ignore).toBeUndefined();
    expect(config.not_allowed_message).toBeUndefined();
    expect(config.message_prefix).toBeUndefined();
  });
});

describe("whatsappAccountConfigAdapter.toConfigSnapshotConfig", () => {
  test("matches toAccountConfig for waiting fields", () => {
    const account = makeAccount({
      waitingBehavior: "typing_indicator",
      waitingMessage: "Please wait...",
    });
    expect(
      whatsappAccountConfigAdapter.toConfigSnapshotConfig(account),
    ).toMatchObject({
      waiting_behavior: "typing_indicator",
      waiting_message: "Please wait...",
    });
  });

  test("matches toAccountConfig for PR 5 fields", () => {
    const account = makeAccount({
      notAllowedIgnore: false,
      notAllowedMessage: "Denied",
      messagePrefix: "\u{1FAE0}",
    });
    expect(
      whatsappAccountConfigAdapter.toConfigSnapshotConfig(account),
    ).toMatchObject({
      not_allowed_ignore: false,
      not_allowed_message: "Denied",
      message_prefix: "\u{1FAE0}",
    });
  });
});
