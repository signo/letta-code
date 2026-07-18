import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Backend } from "@/backend";
import { BACKEND_AGENT_ADMIN_CAPABILITIES } from "@/backend";
import {
  createModAgentAdmin,
  isBackendAgentAdminSupported,
  type ModAgentAdminV1,
} from "@/mods/backend-agent-admin";

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
    tags: ["tag"],
    tools: [],
    model: "provider/model",
    model_settings: { temperature: 0.2, nested: { enabled: true } },
    compaction_settings: {
      mode: "all",
      model_settings: { temperature: 0.1 },
    },
    enable_sleeptime: false,
    hidden: false,
    description: "description",
    secrets: { shouldNot: "escape" },
  } as unknown as AgentState;
}

function createBackend(
  options: {
    listAgents?: Backend["listAgents"];
    retrieveAgent?: Backend["retrieveAgent"];
    updateAgent?: Backend["updateAgent"];
    agentAdmin?: boolean;
  } = {},
): Backend {
  return {
    capabilities: {
      agentAdmin:
        options.agentAdmin === false
          ? undefined
          : BACKEND_AGENT_ADMIN_CAPABILITIES,
      remoteMemfs: false,
      serverSideToolManagement: false,
      serverSecrets: false,
      agentFileImportExport: false,
      promptRecompile: false,
      byokProviderRefresh: false,
      localModelCatalog: false,
      localMemfs: false,
    },
    listAgents:
      options.listAgents ??
      (async () => ({ items: [createAgent("agent-1")] }) as never),
    retrieveAgent:
      options.retrieveAgent ?? (async () => createAgent("agent-1")),
    updateAgent:
      options.updateAgent ?? (async () => createAgent("agent-1", "Updated")),
  } as unknown as Backend;
}

function createAdmin(
  getBackend: () => Backend | undefined,
  isLive = () => true,
): ModAgentAdminV1 {
  return createModAgentAdmin({
    getBackend,
    isLive,
    signal: new AbortController().signal,
  });
}

describe("mod active-backend agent administration", () => {
  beforeEach(() => {
    mock.restore();
  });

  test("normalizes local-style pages and excludes sensitive record fields", async () => {
    const admin = createAdmin(() => createBackend());

    const page = await admin.list();

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.nextPage).toBeNull();
    expect(page.items[0]).toEqual({
      id: "agent-1",
      name: "Agent",
      description: "description",
      model: "provider/model",
      modelSettings: { temperature: 0.2, nested: { enabled: true } },
      compactionSettings: {
        clipChars: null,
        mode: "all",
        model: null,
        modelSettings: { temperature: 0.1 },
      },
      enableSleeptime: false,
      hidden: false,
      tags: ["tag"],
    });
    expect(page.items[0]).not.toHaveProperty("system");
    expect(page.items[0]).not.toHaveProperty("secrets");
    expect(Object.isFrozen(page.items[0])).toBe(true);
    expect(Object.isFrozen(page.items[0]?.modelSettings)).toBe(true);
    expect(Object.isFrozen(page.items[0]?.compactionSettings)).toBe(true);
    expect(() => {
      (page.items[0]?.modelSettings as { temperature: number }).temperature = 1;
    }).toThrow();
  });

  test("normalizes SDK paginated pages", async () => {
    const agent = createAgent("agent-2");
    const listAgents = mock(
      async () =>
        ({
          getPaginatedItems: () => [agent],
        }) as never,
    );
    const admin = createAdmin(() => createBackend({ listAgents }));

    await expect(admin.list({ limit: 1 })).resolves.toMatchObject({
      items: [{ id: "agent-2" }],
    });
    expect(listAgents).toHaveBeenCalledWith({ limit: 1 });
  });

  test("preserves SDK page continuation without exposing the SDK page", async () => {
    const first = createAgent("agent-first");
    const second = createAgent("agent-second");
    const secondPage = {
      getPaginatedItems: () => [second],
      hasNextPage: () => false,
      getNextPage: async () => secondPage,
    };
    const firstPage = {
      getPaginatedItems: () => [first],
      hasNextPage: () => true,
      getNextPage: async () => secondPage,
    };
    const listAgents = mock(async () => firstPage as never);
    const admin = createAdmin(() => createBackend({ listAgents }));

    const page = await admin.list({ limit: 1 });
    expect(page.hasMore).toBe(true);
    expect(page.nextPage).toEqual(expect.any(Function));
    const nextPage = await page.nextPage?.();
    expect(nextPage?.items.map((item) => item.id)).toEqual(["agent-second"]);
    expect(nextPage?.nextPage).toBeNull();
    expect(page).not.toHaveProperty("getNextPage");
  });

  test("provides a closed cursor continuation for local-style pages", async () => {
    const listAgents = mock(
      async (body?: Record<string, unknown>) =>
        ({
          items: [
            createAgent(
              body?.after === "agent-first" ? "agent-second" : "agent-first",
            ),
          ],
        }) as never,
    );
    const admin = createAdmin(() => createBackend({ listAgents }));

    const page = await admin.list({ limit: 1 });
    const nextPage = await page.nextPage?.();
    expect(page.hasMore).toBe(true);
    expect(nextPage?.items.map((item) => item.id)).toEqual(["agent-second"]);
    expect(listAgents).toHaveBeenNthCalledWith(2, {
      after: "agent-first",
      before: undefined,
      limit: 1,
    });
  });

  test("rejects page continuation after the owner becomes stale", async () => {
    let live = true;
    const admin = createAdmin(
      () => createBackend(),
      () => live,
    );
    const page = await admin.list({ limit: 1 });
    live = false;

    await expect(page.nextPage?.()).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("resolves the active backend for every operation", async () => {
    const backendA = createBackend({
      retrieveAgent: async () => createAgent("a"),
    });
    const backendB = createBackend({
      retrieveAgent: async () => createAgent("b"),
    });
    let backend = backendA;
    const admin = createAdmin(() => backend);

    await expect(admin.retrieve("agent-1")).resolves.toMatchObject({ id: "a" });
    backend = backendB;
    await expect(admin.retrieve("agent-1")).resolves.toMatchObject({ id: "b" });
  });

  test("exposes only list, retrieve, and update", () => {
    const admin = createAdmin(() => createBackend());

    expect(Object.keys(admin)).toEqual([
      "apiVersion",
      "capabilities",
      "list",
      "retrieve",
      "update",
    ]);
    expect(admin.capabilities).toEqual({
      list: true,
      retrieve: true,
      update: true,
      create: false,
      delete: false,
    });
    expect(admin).not.toHaveProperty("backend");
    expect(admin).not.toHaveProperty("create");
    expect(admin).not.toHaveProperty("delete");
  });

  test("rejects unsupported update fields before backend invocation", async () => {
    const updateAgent = mock(async () => createAgent("agent-1"));
    const admin = createAdmin(() => createBackend({ updateAgent }));

    await expect(
      admin.update("agent-1", { secrets: { token: "secret" } } as never),
    ).rejects.toThrow("not supported");
    expect(updateAgent).not.toHaveBeenCalled();
  });

  test("validates and maps the closed update DTO", async () => {
    const updateAgent = mock(async () => createAgent("agent-1", "Updated"));
    const admin = createAdmin(() => createBackend({ updateAgent }));

    await admin.update("agent-1", {
      compactionSettings: { mode: "all", model: "provider/cheap" },
      model: "provider/model-2",
      modelSettings: { temperature: 0.3 },
      name: "Updated",
      tags: ["one"],
    });

    expect(updateAgent).toHaveBeenCalledWith("agent-1", {
      compaction_settings: { mode: "all", model: "provider/cheap" },
      model: "provider/model-2",
      model_settings: { temperature: 0.3 },
      name: "Updated",
      tags: ["one"],
    });
  });

  test("rejects malformed records and invalid patches", async () => {
    const malformedList = mock(
      async () =>
        ({
          items: [{ id: "", name: "Bad", tags: [] }],
        }) as never,
    );
    const admin = createAdmin(() =>
      createBackend({ listAgents: malformedList }),
    );

    await expect(admin.list()).rejects.toThrow("invalid id");
    await expect(admin.update("agent-1", {} as never)).rejects.toThrow(
      "non-empty",
    );
    await expect(
      admin.update("agent-1", { tags: [1] } as never),
    ).rejects.toThrow("array of strings");
  });

  test("validates the structural backend capability", () => {
    expect(
      isBackendAgentAdminSupported({
        list: true,
        retrieve: true,
        update: true,
      }),
    ).toBe(true);
    expect(isBackendAgentAdminSupported({ list: true })).toBe(false);
    expect(
      isBackendAgentAdminSupported({ list: true, retrieve: true, update: 1 }),
    ).toBe(false);
    expect(
      isBackendAgentAdminSupported({
        list: true,
        retrieve: true,
        update: true,
        create: true,
      }),
    ).toBe(true);
  });

  test("rejects caller abort before invoking the backend", async () => {
    const retrieveAgent = mock(async () => createAgent("agent-1"));
    const admin = createAdmin(() => createBackend({ retrieveAgent }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      admin.retrieve("agent-1", { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(retrieveAgent).not.toHaveBeenCalled();
  });

  test("rejects stale owners before invoking the backend", async () => {
    const listAgents = mock(async () => ({ items: [] }) as never);
    const admin = createAdmin(
      () => createBackend({ listAgents }),
      () => false,
    );

    await expect(admin.list()).rejects.toMatchObject({ name: "AbortError" });
    expect(listAgents).not.toHaveBeenCalled();
  });

  test("reports unavailable backend capability without fallback", async () => {
    const listAgents = mock(async () => ({ items: [] }) as never);
    const admin = createAdmin(() =>
      createBackend({ agentAdmin: false, listAgents }),
    );

    await expect(admin.list()).rejects.toThrow("unavailable");
    expect(listAgents).not.toHaveBeenCalled();
  });
});
