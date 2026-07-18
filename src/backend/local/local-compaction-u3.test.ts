import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIBackend } from "@/backend";
import { resolveCompactionModelPrecedence } from "@/backend/local/compaction-settings";
import { LocalBackend } from "@/backend/local/local-backend";

describe("U3 backend compaction-model seam", () => {
  test("capability descriptor distinguishes local (U3) from API/stock", () => {
    const apiBackend = new APIBackend();
    expect(apiBackend.capabilities.compaction.explicitModel).toBe(false);

    const localBackend = new LocalBackend({
      storageDir: "/tmp/letta-u3-capability-check",
      memfsEnabled: false,
    });
    expect(localBackend.capabilities.compaction.explicitModel).toBe(true);
  });

  test("precedence: request override wins over agent compaction setting", () => {
    expect(
      resolveCompactionModelPrecedence(
        { model: "anthropic/claude-opus-4-8" },
        { model: "anthropic/claude-sonnet-4-6" },
      ),
    ).toBe("anthropic/claude-opus-4-8");
  });

  test("precedence: agent compaction setting applies when request omits model", () => {
    expect(
      resolveCompactionModelPrecedence(
        { mode: "all" },
        {
          model: "anthropic/claude-opus-4-8",
        },
      ),
    ).toBe("anthropic/claude-opus-4-8");
  });

  test("precedence: undefined when neither request nor agent declares a model", () => {
    expect(
      resolveCompactionModelPrecedence({ mode: "all" }, {}),
    ).toBeUndefined();
  });

  test("precedence: unselected handles fall through to undefined (conversation model)", () => {
    expect(
      resolveCompactionModelPrecedence(
        { model: "local/default" },
        { model: "local/default" },
      ),
    ).toBeUndefined();
  });

  test("precedence: null clears explicitly", () => {
    expect(
      resolveCompactionModelPrecedence(
        { model: null },
        { model: "anthropic/claude-opus-4-8" },
      ),
    ).toBeNull();
  });

  test("precedence: empty/whitespace request model falls through to agent setting", () => {
    expect(
      resolveCompactionModelPrecedence(
        { model: "   " },
        { model: "anthropic/claude-opus-4-8" },
      ),
    ).toBe("anthropic/claude-opus-4-8");
  });
});

// Regression: localCompactionSettingsForStorage must treat `model` as a
// managed compaction field. Previously it only checked the four legacy fields
// (mode/prompt/clip_chars/sliding_window_percentage), so a model-only update
// was treated as "no managed setting" and the storage write was skipped —
// silently dropping the compaction-model override.
describe("U3 model-only compaction settings persistence", () => {
  test("createAgent persists a model-only compaction setting", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "u3-compaction-model-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Local",
        model: "anthropic/claude-opus-4-8",
        model_settings: { provider_type: "anthropic" },
        compaction_settings: { model: "anthropic/claude-sonnet-4-6" },
      } as never);

      expect(agent.compaction_settings).toEqual({
        model: "anthropic/claude-sonnet-4-6",
      });

      // Round-trip through retrieveAgent to confirm it is persisted, not just
      // echoed on the create response.
      const reloaded = await backend.retrieveAgent(agent.id);
      expect(reloaded.compaction_settings).toEqual({
        model: "anthropic/claude-sonnet-4-6",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("updateAgent persists a model-only compaction setting on an agent with no prior settings", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "u3-compaction-model-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Local",
        model: "anthropic/claude-opus-4-8",
        model_settings: { provider_type: "anthropic" },
      } as never);
      expect(agent.compaction_settings).toBeUndefined();

      const updated = await backend.updateAgent(agent.id, {
        compaction_settings: { model: "anthropic/claude-haiku-4-5" },
      } as never);
      expect(updated.compaction_settings).toEqual({
        model: "anthropic/claude-haiku-4-5",
      });

      const reloaded = await backend.retrieveAgent(agent.id);
      expect(reloaded.compaction_settings).toEqual({
        model: "anthropic/claude-haiku-4-5",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("model-only compaction setting survives a backend reload", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "u3-compaction-model-"));
    try {
      let backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Local",
        model: "anthropic/claude-opus-4-8",
        model_settings: { provider_type: "anthropic" },
        compaction_settings: { model: "anthropic/claude-sonnet-4-6" },
      } as never);
      expect(agent.compaction_settings).toEqual({
        model: "anthropic/claude-sonnet-4-6",
      });

      // Simulate a process restart by constructing a fresh backend over the
      // same storage directory.
      backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const reloaded = await backend.retrieveAgent(agent.id);
      expect(reloaded.compaction_settings).toEqual({
        model: "anthropic/claude-sonnet-4-6",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("explicit null compaction setting clears stored settings (not dropped)", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "u3-compaction-model-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Local",
        model: "anthropic/claude-opus-4-8",
        model_settings: { provider_type: "anthropic" },
        compaction_settings: { model: "anthropic/claude-sonnet-4-6" },
      } as never);
      expect(agent.compaction_settings).toEqual({
        model: "anthropic/claude-sonnet-4-6",
      });

      const cleared = await backend.updateAgent(agent.id, {
        compaction_settings: null,
      } as never);
      expect(cleared.compaction_settings).toBeNull();
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
