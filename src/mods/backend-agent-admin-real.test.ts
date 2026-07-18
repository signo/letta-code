import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { APIBackend, type APIClient, type Backend } from "@/backend";
import { HeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { createModAgentAdmin } from "@/mods/backend-agent-admin";

function createAgent(id: string, name = "Agent"): AgentState {
  return {
    id,
    agent_type: "letta_v1_agent",
    blocks: [],
    llm_config: {} as AgentState["llm_config"],
    memory: {} as AgentState["memory"],
    name,
    sources: [],
    system: "private prompt",
    tags: ["visible"],
    tools: [],
    model: "provider/model",
    model_settings: { temperature: 0.2 },
    compaction_settings: { mode: "all" },
    description: "description",
  } as unknown as AgentState;
}

function createAdmin(backend: Backend, signal = new AbortController().signal) {
  return createModAgentAdmin({
    getBackend: () => backend,
    isLive: () => true,
    signal,
  });
}

describe("mod active-backend agent administration real backends", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("normalizes an API page and maps public list filters", async () => {
    const agent = createAgent("api-agent");
    const list = mock(async () => ({ getPaginatedItems: () => [agent] }));
    const client = {
      agents: {
        list,
        retrieve: async () => agent,
        update: async () => agent,
      },
    } as unknown as APIClient;
    const backend = new APIBackend({
      getClient: async () => client,
    });

    const page = await createAdmin(backend).list({
      limit: 10,
      queryText: "api",
      tags: ["visible"],
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("api-agent");
    expect(page.items[0]).not.toHaveProperty("system");
    expect(list).toHaveBeenCalledWith({
      limit: 10,
      query_text: "api",
      tags: ["visible"],
    });
  });

  test("performs local read-after-write and preserves hidden-agent filtering", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "letta-agent-admin-local-"));
    temporaryRoots.push(root);
    const backend = new LocalBackend({
      storageDir: root,
      executionMode: "deterministic",
      memfsEnabled: false,
    });
    const visible = await backend.createAgent({ name: "before" } as never);
    const hidden = await backend.createAgent({
      hidden: true,
      name: "hidden",
    } as never);
    const admin = createAdmin(backend);

    await admin.update(visible.id, { name: "after" });
    await expect(admin.retrieve(visible.id)).resolves.toMatchObject({
      id: visible.id,
      name: "after",
    });

    const page = await admin.list({ limit: 20 });
    expect(page.items.map((item) => item.id)).toContain(visible.id);
    expect(page.items.map((item) => item.id)).not.toContain(hidden.id);
    await expect(admin.retrieve(hidden.id)).resolves.toMatchObject({
      id: hidden.id,
      hidden: true,
    });
  });

  test("preserves hidden-agent filtering on the headless local backend", async () => {
    const backend = new HeadlessBackend("agent-admin-headless", undefined, {
      strictAgentAccess: false,
    });
    const visible = await backend.createAgent({ name: "visible" } as never);
    const hidden = await backend.createAgent({
      hidden: true,
      name: "hidden",
    } as never);
    const admin = createAdmin(backend);

    const page = await admin.list({ limit: 20 });
    expect(page.items.map((item) => item.id)).toContain(visible.id);
    expect(page.items.map((item) => item.id)).not.toContain(hidden.id);
  });

  test("exposes the active backend's explicit compaction-model capability", () => {
    const root = mkdtempSync(path.join(tmpdir(), "letta-agent-admin-cap-"));
    temporaryRoots.push(root);
    const local = new LocalBackend({
      storageDir: root,
      executionMode: "deterministic",
      memfsEnabled: false,
    });
    expect(createAdmin(local).capabilities.compaction).toEqual({
      explicitModel: true,
    });
    expect(createAdmin(new APIBackend()).capabilities.compaction).toEqual({
      explicitModel: false,
    });
  });

  test("rejects a result when the owner aborts during an operation", async () => {
    const controller = new AbortController();
    const agent = createAgent("abort-agent");
    const backend = {
      capabilities: {
        agentAdmin: { list: true, retrieve: true, update: true },
      },
      listAgents: async () => {
        controller.abort();
        return { items: [agent] };
      },
      retrieveAgent: async () => agent,
      updateAgent: async () => agent,
    } as unknown as Backend;

    await expect(
      createAdmin(backend, controller.signal).list(),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
