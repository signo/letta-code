import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";
import { summarizeLocalMessagesAll } from "./compaction";
import { emptyLocalUsage, type LocalMessage } from "./local-message";

function summaryAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "summary of prior work" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("local compaction summarizer options", () => {
  test("uses Opus for Fable compaction summaries while preserving reasoning", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      const messages: LocalMessage[] = [
        {
          id: "ui-msg-1",
          role: "user",
          content: "please summarize this conversation",
          timestamp: Date.now(),
        },
      ];

      let capturedOptions:
        | (SimpleStreamOptions & Record<string, unknown>)
        | undefined;
      let capturedModelId: string | undefined;
      const summary = await summarizeLocalMessagesAll({
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "anthropic/claude-fable-5",
          model_settings: {
            provider_type: "anthropic",
            effort: "max",
            thinking: { type: "enabled" },
          },
        },
        messages,
        localProviderAuthStorageDir: storageDir,
        complete: async (model, _context, options) => {
          capturedModelId = model.id;
          capturedOptions = options;
          return summaryAssistantMessage();
        },
      });

      expect(summary).toBe("summary of prior work");
      // Fable 5 can refuse compaction-summarizer prompts and pi-ai currently
      // masks that refusal as "An unknown error occurred". Use Opus for the
      // auxiliary summary call while preserving the session reasoning level.
      expect(capturedModelId).toBe("claude-opus-4-8");
      // Pi parity (createSummarizationOptions): summarization requests carry
      // the session thinking level. Without options.reasoning, pi-ai sends
      // `thinking: {type: "disabled"}`, which adaptive-thinking Anthropic
      // models (claude-fable-5) reject with a 400 invalid_request_error.
      expect(capturedOptions?.reasoning).toBe("xhigh");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("omits reasoning when model settings disable thinking", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      let capturedOptions:
        | (SimpleStreamOptions & Record<string, unknown>)
        | undefined;
      let capturedModelId: string | undefined;
      await summarizeLocalMessagesAll({
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "anthropic/claude-sonnet-4-6",
          model_settings: {
            provider_type: "anthropic",
            thinking: { type: "disabled" },
          },
        },
        messages: [
          {
            id: "ui-msg-1",
            role: "user",
            content: "please summarize this conversation",
            timestamp: Date.now(),
          },
        ],
        localProviderAuthStorageDir: storageDir,
        complete: async (model, _context, options) => {
          capturedModelId = model.id;
          capturedOptions = options;
          return summaryAssistantMessage();
        },
      });

      expect(capturedModelId).toBe("claude-sonnet-4-6");
      expect(capturedOptions?.reasoning).toBeUndefined();
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("U3: explicit compactionModel overrides the agent model", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      let capturedModelId: string | undefined;
      const summary = await summarizeLocalMessagesAll({
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "anthropic/claude-sonnet-4-6",
          model_settings: { provider_type: "anthropic" },
        },
        messages: [
          {
            id: "ui-msg-1",
            role: "user",
            content: "please summarize this conversation",
            timestamp: Date.now(),
          },
        ],
        localProviderAuthStorageDir: storageDir,
        compactionModel: "anthropic/claude-opus-4-8",
        complete: async (model, _context, _options) => {
          capturedModelId = model.id;
          return summaryAssistantMessage();
        },
      });

      expect(summary).toBe("summary of prior work");
      expect(capturedModelId).toBe("claude-opus-4-8");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("U3: absent compactionModel preserves conversation-model behavior", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      let capturedModelId: string | undefined;
      await summarizeLocalMessagesAll({
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "anthropic/claude-sonnet-4-6",
          model_settings: { provider_type: "anthropic" },
        },
        messages: [
          {
            id: "ui-msg-1",
            role: "user",
            content: "please summarize this conversation",
            timestamp: Date.now(),
          },
        ],
        localProviderAuthStorageDir: storageDir,
        complete: async (model, _context, _options) => {
          capturedModelId = model.id;
          return summaryAssistantMessage();
        },
      });

      expect(capturedModelId).toBe("claude-sonnet-4-6");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("U3: unselected compactionModel preserves conversation-model behavior", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      let capturedModelId: string | undefined;
      await summarizeLocalMessagesAll({
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "anthropic/claude-sonnet-4-6",
          model_settings: { provider_type: "anthropic" },
        },
        messages: [
          {
            id: "ui-msg-1",
            role: "user",
            content: "please summarize this conversation",
            timestamp: Date.now(),
          },
        ],
        localProviderAuthStorageDir: storageDir,
        compactionModel: "local/default",
        complete: async (model, _context, _options) => {
          capturedModelId = model.id;
          return summaryAssistantMessage();
        },
      });

      expect(capturedModelId).toBe("claude-sonnet-4-6");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("U3: invalid explicit compactionModel fails visibly without silent fallback", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      let capturedModelId: string | undefined;
      const promise = summarizeLocalMessagesAll({
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "anthropic/claude-sonnet-4-6",
          model_settings: { provider_type: "anthropic" },
        },
        messages: [
          {
            id: "ui-msg-1",
            role: "user",
            content: "please summarize this conversation",
            timestamp: Date.now(),
          },
        ],
        localProviderAuthStorageDir: storageDir,
        compactionModel: "anthropic/this-model-does-not-exist",
        complete: async (model, _context, _options) => {
          capturedModelId = model.id;
          return summaryAssistantMessage();
        },
      });

      await expect(promise).rejects.toThrow(/this-model-does-not-exist/);
      expect(capturedModelId).toBeUndefined();
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("U3: explicit compactionModel does not mutate the agent/conversation model", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });
      const agent = {
        id: "agent-local-1",
        name: "Local",
        description: null,
        system: "",
        tags: [],
        model: "anthropic/claude-sonnet-4-6",
        model_settings: { provider_type: "anthropic" },
      };
      const agentBefore = JSON.parse(JSON.stringify(agent));
      await summarizeLocalMessagesAll({
        agent,
        messages: [
          {
            id: "ui-msg-1",
            role: "user",
            content: "please summarize this conversation",
            timestamp: Date.now(),
          },
        ],
        localProviderAuthStorageDir: storageDir,
        compactionModel: "anthropic/claude-opus-4-8",
        complete: async (_model, _context, _options) =>
          summaryAssistantMessage(),
      });
      // The explicit compaction model must not mutate the agent record or be
      // written back to the conversation model.
      expect(JSON.parse(JSON.stringify(agent))).toEqual(agentBefore);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  // Regression: a concrete explicit compactionModel is authoritative and must
  // NOT trigger the inherited Fable→Opus summary fallback. Previously, an
  // explicit compactionModel of "anthropic/claude-fable-5" was silently
  // replaced by Opus, overriding the user's explicit choice.
  test("U3: explicit Fable compactionModel is authoritative (no Fable→Opus fallback)", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      let capturedModelId: string | undefined;
      await summarizeLocalMessagesAll({
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "anthropic/claude-sonnet-4-6",
          model_settings: { provider_type: "anthropic" },
        },
        messages: [
          {
            id: "ui-msg-1",
            role: "user",
            content: "please summarize this conversation",
            timestamp: Date.now(),
          },
        ],
        localProviderAuthStorageDir: storageDir,
        compactionModel: "anthropic/claude-fable-5",
        complete: async (model, _context, _options) => {
          capturedModelId = model.id;
          return summaryAssistantMessage();
        },
      });

      expect(capturedModelId).toBe("claude-fable-5");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  // Regression: whitespace-only explicit compactionModel must be treated as
  // absent (conversation-model behavior), including the Fable→Opus fallback
  // when the inherited conversation model is Fable.
  test("U3: whitespace compactionModel is absent — Fable conversation model still falls back to Opus", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      let capturedModelId: string | undefined;
      await summarizeLocalMessagesAll({
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "anthropic/claude-fable-5",
          model_settings: { provider_type: "anthropic" },
        },
        messages: [
          {
            id: "ui-msg-1",
            role: "user",
            content: "please summarize this conversation",
            timestamp: Date.now(),
          },
        ],
        localProviderAuthStorageDir: storageDir,
        compactionModel: "   ",
        complete: async (model, _context, _options) => {
          capturedModelId = model.id;
          return summaryAssistantMessage();
        },
      });

      expect(capturedModelId).toBe("claude-opus-4-8");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
