import { describe, expect, test } from "bun:test";
import type { ChannelMessageActionContext } from "@/channels/plugin-types";
import type { ChannelAdapter, OutboundChannelMessage } from "@/channels/types";
import { whatsappMessageActions } from "@/channels/whatsapp/message-actions";

function makeContext(action: string, overrides: Record<string, unknown> = {}) {
  const sent: OutboundChannelMessage[] = [];
  const adapter: ChannelAdapter = {
    id: "whatsapp:test",
    channelId: "whatsapp",
    accountId: "acct",
    name: "WhatsApp",
    async start() {},
    async stop() {},
    isRunning() {
      return true;
    },
    async sendMessage(msg) {
      sent.push(msg);
      return { messageId: "msg-1" };
    },
    async sendDirectReply() {},
  };
  const ctx: ChannelMessageActionContext = {
    request: {
      action,
      channel: "whatsapp",
      chatId: "15551234567@s.whatsapp.net",
      ...overrides,
    },
    route: {
      accountId: "acct",
      chatId: "15551234567@s.whatsapp.net",
      agentId: "agent-test",
      conversationId: "conv-test",
      enabled: true,
      createdAt: "2026-04-30T00:00:00.000Z",
    },
    adapter,
    formatText(text) {
      return { text };
    },
  };
  return { ctx, sent };
}

describe("WhatsApp MessageChannel actions", () => {
  test("advertises send, react, and upload-file", () => {
    expect(whatsappMessageActions.describeMessageTool({}).actions).toEqual([
      "send",
      "react",
      "upload-file",
    ]);
  });

  test("documents the Ogg/Opus requirement for media uploads", () => {
    const desc = whatsappMessageActions.describeMessageTool({}).schema;
    expect(desc.properties.media.description).toContain("Ogg/Opus");
    expect(desc.properties.media.description).not.toContain("rejected");
    expect(desc.properties.media.description).not.toContain("reject");
  });

  test("sends text messages", async () => {
    const { ctx, sent } = makeContext("send", { message: "hello" });
    await expect(whatsappMessageActions.handleAction(ctx)).resolves.toContain(
      "Message sent",
    );
    expect(sent[0]).toEqual(
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "acct",
        chatId: "15551234567@s.whatsapp.net",
        text: "hello",
      }),
    );
  });

  test("validates upload-file media path", async () => {
    const { ctx } = makeContext("upload-file");
    await expect(whatsappMessageActions.handleAction(ctx)).resolves.toMatch(
      /requires media/,
    );
  });

  test("upload-file with .mp3 reaches adapter as document", async () => {
    const { ctx, sent } = makeContext("upload-file", {
      mediaPath: "/tmp/song.mp3",
    });

    await expect(whatsappMessageActions.handleAction(ctx)).resolves.toMatch(
      /Attachment sent/,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.objectContaining({
        mediaPath: "/tmp/song.mp3",
      }),
    );
    // No audio/PTT — MP3 is a document
    expect(sent[0]).not.toEqual(
      expect.objectContaining({ ptt: expect.anything() }),
    );
    expect(sent[0]).not.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Error") }),
    );
  });

  test("upload-file with .mp3 uses filename extension over mediaPath", async () => {
    const { ctx, sent } = makeContext("upload-file", {
      mediaPath: "/tmp/upload",
      filename: "song.mp3",
    });

    await expect(whatsappMessageActions.handleAction(ctx)).resolves.toMatch(
      /Attachment sent/,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.objectContaining({
        mediaPath: "/tmp/upload",
        fileName: "song.mp3",
      }),
    );
  });

  test("sends reactions", async () => {
    const { ctx, sent } = makeContext("react", {
      emoji: "👍",
      messageId: "target-msg",
    });
    await expect(whatsappMessageActions.handleAction(ctx)).resolves.toContain(
      "Reaction added",
    );
    expect(sent[0]).toEqual(
      expect.objectContaining({
        reaction: "👍",
        targetMessageId: "target-msg",
      }),
    );
  });
});
