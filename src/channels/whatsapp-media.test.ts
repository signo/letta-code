import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  buildWhatsAppOutboundPayload,
  collectWhatsAppAttachments,
  extractMentionedJids,
  extractReplyParticipant,
  extractWhatsAppText,
} from "@/channels/whatsapp/media";

describe("WhatsApp media helpers", () => {
  test("extracts text and captions from wrapped message content", () => {
    expect(extractWhatsAppText({ conversation: "hello" })).toBe("hello");
    expect(
      extractWhatsAppText({
        ephemeralMessage: {
          message: { imageMessage: { caption: "photo caption" } },
        },
      }),
    ).toBe("photo caption");
  });

  test("extracts mentions and reply participants from context info", () => {
    const message = {
      extendedTextMessage: {
        text: "loop",
        contextInfo: {
          mentionedJid: ["15551234567@s.whatsapp.net"],
          participant: "15550000000@s.whatsapp.net",
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([
      "15551234567@s.whatsapp.net",
    ]);
    expect(extractReplyParticipant(message)).toBe("15550000000@s.whatsapp.net");
  });

  test("builds outbound payloads by file type", () => {
    expect(
      buildWhatsAppOutboundPayload({
        text: "caption",
        mediaPath: "/tmp/photo.png",
      }),
    ).toEqual({ image: { url: "/tmp/photo.png" }, caption: "caption" });
    expect(
      buildWhatsAppOutboundPayload({
        text: "",
        mediaPath: "/tmp/voice.ogg",
      }),
    ).toEqual({
      audio: { url: "/tmp/voice.ogg" },
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    });
  });

  test("rejects non-Ogg/Opus audio for outbound voice memos", () => {
    expect(() =>
      buildWhatsAppOutboundPayload({
        text: "",
        mediaPath: "/tmp/voice.mp3",
      }),
    ).toThrow(/Ogg\/Opus/);
  });

  test("returns attachment metadata without downloading when media is disabled", async () => {
    const result = await collectWhatsAppAttachments({
      accountId: "acct",
      chatId: "15551234567@s.whatsapp.net",
      messageId: "msg1",
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileLength: 123,
        },
      },
      downloadMedia: false,
      transcribeVoice: false,
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual(
      expect.objectContaining({
        kind: "image",
        mimeType: "image/jpeg",
        sizeBytes: 123,
        localPath: "",
      }),
    );
  });

  test("stops downloading when streamed media exceeds the byte cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "whatsapp-media-"));
    __testOverrideChannelsRoot(root);
    try {
      async function* oversizedStream() {
        yield Buffer.from("12");
        yield Buffer.from("34");
      }

      const result = await collectWhatsAppAttachments({
        accountId: "acct",
        chatId: "15551234567@s.whatsapp.net",
        messageId: "msg2",
        message: {
          imageMessage: {
            mimetype: "image/jpeg",
          },
        },
        downloadContentFromMessage: async () => oversizedStream(),
        downloadMedia: true,
        mediaMaxBytes: 3,
        transcribeVoice: false,
      });

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).toEqual(
        expect.objectContaining({
          kind: "image",
          mimeType: "image/jpeg",
          localPath: "",
        }),
      );
    } finally {
      __testOverrideChannelsRoot(null);
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("builds video payload for video extensions", () => {
  expect(
    buildWhatsAppOutboundPayload({
      text: "clip",
      mediaPath: "/tmp/movie.mp4",
    }),
  ).toEqual({ video: { url: "/tmp/movie.mp4" }, caption: "clip" });
});

test("builds document payload with extension-aware mimetype", () => {
  expect(
    buildWhatsAppOutboundPayload({
      text: "",
      mediaPath: "/tmp/report.pdf",
      fileName: "report.pdf",
    }),
  ).toEqual({
    document: { url: "/tmp/report.pdf" },
    fileName: "report.pdf",
    mimetype: "application/pdf",
  });
});

test("uses text caption over title, and falls back to title", () => {
  expect(
    buildWhatsAppOutboundPayload({
      text: "primary",
      title: "fallback",
      mediaPath: "/tmp/doc.pdf",
    }),
  ).toEqual(
    expect.objectContaining({
      caption: "primary",
    }),
  );

  expect(
    buildWhatsAppOutboundPayload({
      text: "   ",
      title: "fallback",
      mediaPath: "/tmp/doc.pdf",
    }),
  ).toEqual(
    expect.objectContaining({
      caption: "fallback",
    }),
  );
});

test("fileName extension overrides mediaPath extension for type selection", () => {
  expect(
    buildWhatsAppOutboundPayload({
      text: "",
      mediaPath: "/tmp/upload.bin",
      fileName: "photo.jpg",
    }),
  ).toEqual({ image: { url: "/tmp/upload.bin" } });
});

describe("collectWhatsAppAttachments — downloadSkipReason", () => {
  const baseParams = {
    accountId: "acct",
    chatId: "15551234567@s.whatsapp.net",
    messageId: "msg-skip",
    message: {
      imageMessage: {
        mimetype: "image/png",
        fileLength: 1000,
      },
    },
    transcribeVoice: false,
  };

  test("download_disabled when downloadMedia is false", async () => {
    const result = await collectWhatsAppAttachments({
      ...baseParams,
      downloadMedia: false,
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.downloadSkipReason).toBe("download_disabled");
    expect(result.attachments[0]?.localPath).toBe("");
  });

  test("missing_runtime_downloader when downloadContentFromMessage is absent", async () => {
    const result = await collectWhatsAppAttachments({
      ...baseParams,
      downloadMedia: true,
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.downloadSkipReason).toBe(
      "missing_runtime_downloader",
    );
    expect(result.attachments[0]?.localPath).toBe("");
  });

  test("exceeds_max_bytes when fileLength exceeds cap", async () => {
    const result = await collectWhatsAppAttachments({
      ...baseParams,
      downloadMedia: true,
      downloadContentFromMessage: async () => {
        throw new Error("should not be called");
      },
      mediaMaxBytes: 500,
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.downloadSkipReason).toBe("exceeds_max_bytes");
    expect(result.attachments[0]?.localPath).toBe("");
  });

  test("stream_exceeds_max_bytes when stream overflows during read", async () => {
    async function* bigStream() {
      yield Buffer.alloc(200);
      yield Buffer.alloc(200);
      yield Buffer.alloc(200);
    }
    const result = await collectWhatsAppAttachments({
      ...baseParams,
      message: {
        imageMessage: {
          mimetype: "image/png",
        },
      },
      downloadMedia: true,
      downloadContentFromMessage: async () => bigStream(),
      mediaMaxBytes: 400,
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.downloadSkipReason).toBe(
      "stream_exceeds_max_bytes",
    );
    expect(result.attachments[0]?.localPath).toBe("");
  });

  test("no downloadSkipReason when download succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "whatsapp-media-"));
    __testOverrideChannelsRoot(root);
    try {
      async function* tinyStream() {
        yield Buffer.from("ok");
      }
      const result = await collectWhatsAppAttachments({
        ...baseParams,
        downloadMedia: true,
        downloadContentFromMessage: async () => tinyStream(),
        mediaMaxBytes: 1024 * 1024,
      });
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.downloadSkipReason).toBeUndefined();
      expect(result.attachments[0]?.localPath).not.toBe("");
    } finally {
      __testOverrideChannelsRoot(null);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("download_disabled takes precedence over missing downloader", async () => {
    const result = await collectWhatsAppAttachments({
      ...baseParams,
      downloadMedia: false,
    });
    expect(result.attachments[0]?.downloadSkipReason).toBe("download_disabled");
  });
});

describe("collectWhatsAppAttachments — transcriptionStatus baseline", () => {
  test("sets skipped_not_voice for downloaded non-voice attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "whatsapp-media-"));
    __testOverrideChannelsRoot(root);
    try {
      async function* tinyStream() {
        yield Buffer.from("ok");
      }
      const result = await collectWhatsAppAttachments({
        accountId: "acct",
        chatId: "15551234567@s.whatsapp.net",
        messageId: "msg-tx-1",
        message: { imageMessage: { mimetype: "image/jpeg" } },
        downloadContentFromMessage: async () => tinyStream(),
        downloadMedia: true,
        transcribeVoice: true,
      });
      expect(result.attachments[0]?.transcriptionStatus).toBe(
        "skipped_not_voice",
      );
    } finally {
      __testOverrideChannelsRoot(null);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sets skipped_not_enabled for downloaded voice attachments when transcription disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "whatsapp-media-"));
    __testOverrideChannelsRoot(root);
    try {
      async function* tinyStream() {
        yield Buffer.from("ok");
      }
      const result = await collectWhatsAppAttachments({
        accountId: "acct",
        chatId: "15551234567@s.whatsapp.net",
        messageId: "msg-tx-2",
        message: {
          audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true },
        },
        downloadContentFromMessage: async () => tinyStream(),
        downloadMedia: true,
        transcribeVoice: false,
      });
      expect(result.attachments[0]?.transcriptionStatus).toBe(
        "skipped_not_enabled",
      );
    } finally {
      __testOverrideChannelsRoot(null);
      await rm(root, { recursive: true, force: true });
    }
  });
});
