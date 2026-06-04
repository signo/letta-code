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
});
