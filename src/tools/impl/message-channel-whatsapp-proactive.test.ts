/**
 * End-to-end tests for WhatsApp proactive first-contact send (no route).
 *
 * Uses real ChannelRegistry + registered WhatsApp adapters + account store
 * to exercise message_channel() end-to-end, asserting on sendMessage calls
 * and policy enforcement.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  upsertChannelAccount,
} from "@/channels/accounts";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import { clearAllRoutes, setRouteInMemory } from "@/channels/routing";
import type { ChannelAdapter } from "@/channels/types";
import { message_channel } from "@/tools/impl/message-channel";

function makeWhatsAppAdapter(accountId: string): {
  adapter: ChannelAdapter;
  sendMessage: ReturnType<typeof mock>;
} {
  const sendMessage = mock(async () => ({ messageId: `wa-msg-${accountId}` }));
  const adapter: ChannelAdapter = {
    id: `whatsapp:${accountId}`,
    channelId: "whatsapp",
    accountId,
    name: `WhatsApp ${accountId}`,
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage,
    sendDirectReply: async () => {},
  };
  return { adapter, sendMessage };
}

function makeWhatsAppAccount(
  accountId: string,
  overrides: {
    dmPolicy?: "pairing" | "allowlist" | "open";
    allowedUsers?: string[];
    agentId?: string | null;
    sendAttachments?: boolean;
    attachmentMimeTypes?: string[];
    attachmentAllowedRecipients?: string[];
  } = {},
) {
  return {
    channel: "whatsapp" as const,
    accountId,
    displayName: `WA ${accountId}`,
    enabled: true,
    dmPolicy: (overrides.dmPolicy ?? "open") as
      | "pairing"
      | "allowlist"
      | "open",
    allowedUsers: overrides.allowedUsers ?? ["*"],
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
    agentId: overrides.agentId ?? null,
    selfChatMode: true,
    groupMode: "disabled" as const,
    sendAttachments: overrides.sendAttachments,
    attachmentMimeTypes: overrides.attachmentMimeTypes,
    attachmentAllowedRecipients: overrides.attachmentAllowedRecipients,
  };
}

describe("WhatsApp proactive send (no route)", () => {
  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
  });

  // ── Test 1: Proactive phone JID send succeeds ──────────────────

  test("proactive WhatsApp phone JID send succeeds without route", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
      }),
    );

    const result = await message_channel({
      action: "send",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      message: "hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Message sent to whatsapp");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "signo-digi",
        chatId: "584149145006@s.whatsapp.net",
        text: "hello",
      }),
    );
  });

  // ── Test 2: Denies recipient not in allowedUsers ───────────────

  test("denies proactive send when recipient not in allowedUsers", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "allowlist",
        allowedUsers: ["+34600216777"],
      }),
    );

    const result = await message_channel({
      action: "send",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      message: "hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("allowlist");
    expect(result).toContain("584149145006@s.whatsapp.net");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // ── Test 3: Pairing mode denies proactive send ─────────────────

  test("pairing mode denies proactive no-route send", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "pairing",
        allowedUsers: ["*"],
      }),
    );

    const result = await message_channel({
      action: "send",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      message: "hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("pairing");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // ── Test 4: Multiple adapters require accountId ────────────────

  test("multiple WhatsApp adapters require accountId", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter: adapter1, sendMessage: send1 } =
      makeWhatsAppAdapter("signo-digi");
    const { adapter: adapter2, sendMessage: send2 } =
      makeWhatsAppAdapter("signo-other");

    registry.registerAdapter(adapter1);
    registry.registerAdapter(adapter2);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
      }),
    );
    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-other", {
        dmPolicy: "open",
        allowedUsers: ["*"],
      }),
    );

    const result = await message_channel({
      action: "send",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      message: "hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Multiple WhatsApp accounts exist");
    expect(result).toContain("accountId");
    expect(send1).not.toHaveBeenCalled();
    expect(send2).not.toHaveBeenCalled();
  });

  // ── Test 5: Explicit accountId with multiple adapters ──────────

  test("explicit accountId works with multiple WhatsApp adapters", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter: adapter1, sendMessage: send1 } =
      makeWhatsAppAdapter("signo-digi");
    const { adapter: adapter2, sendMessage: send2 } =
      makeWhatsAppAdapter("signo-other");

    registry.registerAdapter(adapter1);
    registry.registerAdapter(adapter2);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
      }),
    );
    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-other", {
        dmPolicy: "open",
        allowedUsers: ["*"],
      }),
    );

    const result = await message_channel({
      action: "send",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      accountId: "signo-digi",
      message: "hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Message sent to whatsapp");
    expect(send1).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "signo-digi",
        chatId: "584149145006@s.whatsapp.net",
        text: "hello",
      }),
    );
    expect(send2).not.toHaveBeenCalled();
  });

  // ── Test 6: Non-WhatsApp no-route unchanged ────────────────────

  test("non-WhatsApp channel returns original no-route error", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    // WhatsApp adapter registered but should NOT be used — this is a Slack test
    registry.registerAdapter(makeWhatsAppAdapter("signo-digi").adapter);

    // Use a Slack adapter to show non-WhatsApp is unaffected
    const slackSendMessage = mock(async () => ({ messageId: "slack-1" }));
    const slackAdapter: ChannelAdapter = {
      id: "slack:account-1",
      channelId: "slack",
      accountId: "account-1",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: slackSendMessage,
      sendDirectReply: async () => {},
    };
    registry.registerAdapter(slackAdapter);

    const result = await message_channel({
      action: "send",
      channel: "slack",
      chat_id: "D123",
      message: "hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("No route for chat_id");
    expect(result).toContain("D123");
    expect(slackSendMessage).not.toHaveBeenCalled();
  });

  // ── Test 7: Routed WhatsApp send uses route, not proactive path ─

  test("existing routed WhatsApp send still uses route", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
      }),
    );

    // Pre-register a route for this chat
    setRouteInMemory("whatsapp", {
      accountId: "signo-digi",
      chatId: "584149145006@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      message: "routed hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Message sent to whatsapp");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "signo-digi",
        chatId: "584149145006@s.whatsapp.net",
        text: "routed hello",
      }),
    );
  });
});

describe("WhatsApp attachment policy (proactive upload-file)", () => {
  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
  });

  test('proactive upload-file succeeds with sendAttachments=true, attachmentAllowedRecipients=["*"], attachmentMimeTypes=["*"]', async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        sendAttachments: true,
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: ["*"],
      }),
    );

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/document.pdf",
      filename: "document.pdf",
      message: "see attached",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Attachment sent to whatsapp");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "signo-digi",
        chatId: "584149145006@s.whatsapp.net",
        mediaPath: "/tmp/document.pdf",
        fileName: "document.pdf",
      }),
    );
  });

  test("proactive upload-file denied when sendAttachments=false (default)", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        // sendAttachments defaults to false — omitted
      }),
    );

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/document.pdf",
      filename: "document.pdf",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("attachments disabled");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("proactive upload-file denied when attachmentAllowedRecipients=[]", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        sendAttachments: true,
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: [],
      }),
    );

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/document.pdf",
      filename: "document.pdf",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("no recipients are allowed");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("proactive upload-file denied when recipient not in attachmentAllowedRecipients", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        sendAttachments: true,
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: ["+34600216777"],
      }),
    );

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/document.pdf",
      filename: "document.pdf",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("not in the allowed recipients list");
    expect(result).toContain("584149145006@s.whatsapp.net");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("proactive upload-file allowed when recipient matches explicit phone-normalized attachmentAllowedRecipients", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        sendAttachments: true,
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: ["+584149145006"],
      }),
    );

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/document.pdf",
      filename: "document.pdf",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Attachment sent to whatsapp");
    expect(sendMessage).toHaveBeenCalled();
  });

  test("proactive upload-file denied when attachmentMimeTypes=[]", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        sendAttachments: true,
        attachmentMimeTypes: [],
        attachmentAllowedRecipients: ["*"],
      }),
    );

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/document.pdf",
      filename: "document.pdf",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("no MIME types are allowed");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("proactive upload-file denied when MIME not in attachmentMimeTypes", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        sendAttachments: true,
        attachmentMimeTypes: ["image/png", "image/jpeg"],
        attachmentAllowedRecipients: ["*"],
      }),
    );

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/document.pdf",
      filename: "document.pdf",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain('MIME type "application/pdf" is not allowed');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("proactive upload-file allowed when MIME matches attachmentMimeTypes", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        sendAttachments: true,
        attachmentMimeTypes: ["application/pdf", "image/png"],
        attachmentAllowedRecipients: ["*"],
      }),
    );

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/document.pdf",
      filename: "document.pdf",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Attachment sent to whatsapp");
    expect(sendMessage).toHaveBeenCalled();
  });

  test("text proactive send unaffected by attachment policy", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    // sendAttachments is false, but this is a text send, not upload-file
    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
      }),
    );

    const result = await message_channel({
      action: "send",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      message: "just text",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Message sent to whatsapp");
    expect(sendMessage).toHaveBeenCalled();
  });

  test("routed WhatsApp upload-file works when policy allows", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        sendAttachments: true,
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: ["*"],
      }),
    );

    setRouteInMemory("whatsapp", {
      accountId: "signo-digi",
      chatId: "584149145006@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/photo.png",
      filename: "photo.png",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Attachment sent to whatsapp");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "signo-digi",
        chatId: "584149145006@s.whatsapp.net",
        mediaPath: "/tmp/photo.png",
      }),
    );
  });

  test("routed WhatsApp upload-file denied when policy blocks", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        // sendAttachments false (default) — blocks upload-file
      }),
    );

    setRouteInMemory("whatsapp", {
      accountId: "signo-digi",
      chatId: "584149145006@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/document.pdf",
      filename: "document.pdf",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("attachments disabled");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("routed WhatsApp upload-file denied when account config is missing", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    // No account config registered — getChannelAccount returns null.
    // Routed upload-file must fail closed, not bypass attachment policy.

    setRouteInMemory("whatsapp", {
      accountId: "signo-digi",
      chatId: "584149145006@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/document.pdf",
      filename: "document.pdf",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("not configured");
    expect(result).toContain("attachment policy");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("proactive upload-file MIME inference uses filename when media path has no extension", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        sendAttachments: true,
        attachmentMimeTypes: ["application/pdf"],
        attachmentAllowedRecipients: ["*"],
      }),
    );

    // media path is a temp file with no extension; filename has the extension
    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/abc123xyz",
      filename: "report.pdf",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Attachment sent to whatsapp");
    expect(sendMessage).toHaveBeenCalled();
  });

  test("routed upload-file MIME inference uses filename when media path has no extension", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();

    const { adapter, sendMessage } = makeWhatsAppAdapter("signo-digi");
    registry.registerAdapter(adapter);

    upsertChannelAccount(
      "whatsapp",
      makeWhatsAppAccount("signo-digi", {
        dmPolicy: "open",
        allowedUsers: ["*"],
        sendAttachments: true,
        attachmentMimeTypes: ["image/png"],
        attachmentAllowedRecipients: ["*"],
      }),
    );

    setRouteInMemory("whatsapp", {
      accountId: "signo-digi",
      chatId: "584149145006@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    // media path is a temp file with no extension; filename has the extension
    const result = await message_channel({
      action: "upload-file",
      channel: "whatsapp",
      chat_id: "584149145006@s.whatsapp.net",
      media: "/tmp/xyz789tmp",
      filename: "snapshot.png",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    });

    expect(result).toContain("Attachment sent to whatsapp");
    expect(sendMessage).toHaveBeenCalled();
  });
});
