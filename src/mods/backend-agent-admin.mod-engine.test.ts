import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import type { Backend } from "@/backend";
import { BACKEND_AGENT_ADMIN_CAPABILITIES } from "@/backend";
import { createModEngine } from "@/mods/mod-engine";
import { clearModPermissions } from "@/mods/permission-registry";
import { clearModTools } from "@/mods/tool-registry";

type TestGlobal = typeof globalThis & {
  __adminPromise?: Promise<unknown>;
  __agentAdmin?: unknown;
};

function createRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-agent-admin-mod-"));
}

function createBackend(agentAdmin: boolean): Backend {
  return {
    capabilities: {
      agentAdmin: agentAdmin ? BACKEND_AGENT_ADMIN_CAPABILITIES : undefined,
    },
    forkConversation: async () => ({ id: "forked" }),
  } as unknown as Backend;
}

function loadEngine(root: string, backend: Backend) {
  return createModEngine({
    cacheDirectory: path.join(root, "cache"),
    getBackend: () => backend,
    getClient: async () => ({}) as unknown as Letta,
    globalModsDirectory: path.join(root, "mods"),
  });
}

describe("mod engine agent administration capability", () => {
  afterEach(() => {
    delete (globalThis as TestGlobal).__agentAdmin;
    delete (globalThis as TestGlobal).__adminPromise;
    clearModPermissions();
    clearModTools();
  });

  test("exposes only the scoped agent administration surface", async () => {
    const root = createRoot();
    try {
      const mods = path.join(root, "mods");
      mkdirSync(mods, { recursive: true });
      writeFileSync(
        path.join(mods, "capture.ts"),
        `export default function(letta) {
          globalThis.__agentAdmin = letta.backend.agentAdmin;
        }`,
      );

      const engine = loadEngine(root, createBackend(true));
      await engine.reload();

      const agentAdmin = (globalThis as TestGlobal).__agentAdmin as {
        apiVersion: number;
        capabilities: Record<string, boolean>;
      };
      expect(agentAdmin.apiVersion).toBe(1);
      expect(agentAdmin.capabilities).toEqual({
        list: true,
        retrieve: true,
        update: true,
        create: false,
        delete: false,
      });
      expect(agentAdmin).not.toHaveProperty("forkConversation");
      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("hides the surface when the active backend lacks the capability", async () => {
    const root = createRoot();
    try {
      const mods = path.join(root, "mods");
      mkdirSync(mods, { recursive: true });
      writeFileSync(
        path.join(mods, "capture.ts"),
        `export default function(letta) {
          globalThis.__agentAdmin = letta.backend.agentAdmin;
        }`,
      );

      const engine = loadEngine(root, createBackend(false));
      await engine.reload();

      expect((globalThis as TestGlobal).__agentAdmin).toBeUndefined();
      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("disposes in-flight owner operations without reviving stale results", async () => {
    const root = createRoot();
    let resolveList: ((page: unknown) => void) | undefined;
    const pendingList = new Promise((resolve) => {
      resolveList = resolve;
    });
    const backend = {
      ...createBackend(true),
      listAgents: async () => pendingList,
    } as unknown as Backend;
    try {
      const mods = path.join(root, "mods");
      mkdirSync(mods, { recursive: true });
      writeFileSync(
        path.join(mods, "capture.ts"),
        `export default function(letta) {
          globalThis.__adminPromise = letta.backend.agentAdmin.list();
        }`,
      );

      const engine = loadEngine(root, backend);
      await engine.reload();
      const operation = (globalThis as TestGlobal).__adminPromise;
      expect(operation).toBeInstanceOf(Promise);
      engine.dispose();
      resolveList?.({ items: [] });

      await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
