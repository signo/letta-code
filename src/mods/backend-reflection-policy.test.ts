import { describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { createModReflectionIdentityResolver, createModReflectionPolicy } from "@/mods/backend-reflection-policy";

function backend(ids: string[]): Backend {
  return {
    retrieveAgent: async (id: string) => {
      if (!ids.includes(id)) throw new Error("agent is outside host scope");
      return { id };
    },
  } as unknown as Backend;
}

const identity = {
  agentId: "agent-a",
  hostKey: "host-local",
  surface: "local" as const,
};

function persistence() {
  const values = new Map<string, any>();
  return {
    read: (key: string) => values.get(key),
    write: (key: string, value: any) => value ? values.set(key, value) : values.delete(key),
  };
}

describe("U4 host reflection policy", () => {
  test("resolves explicit, project, global, and built-in precedence and clears fields", async () => {
    const service = createModReflectionPolicy({
      backend: backend(["agent-a", "agent-b"]),
      surface: "local",
      hostKey: "host-local",
      persistence: persistence(),
      definitions: {
        project: "---\nmodel: inherit\n---\nproject",
        global: "global",
      },
    });
    expect((await service.get(identity)).definitionSource).toBe("project");
    const updated = await service.update(identity, {
      trigger: "compaction-event",
      stepCount: 4,
      model: "provider/model",
      definition: {
        content: "---\nmodel: inherit\n---\nagent",
        ownership: "managed",
      },
    });
    expect(updated.definitionSource).toBe("explicit-agent");
    expect(updated.trigger).toBe("compaction-event");
    expect(updated.stepCount).toBe(4);
    expect(updated.modelBehavior).toBe("explicit");
    expect(updated.definitionOwnership).toBe("managed");
    expect(updated.cacheGeneration).toBe(1);
    const cleared = await service.update(identity, {
      definition: null,
      model: null,
      trigger: null,
      stepCount: null,
    });
    expect(cleared.definitionSource).toBe("project");
    expect(cleared.trigger).toBe("step-count");
    expect(cleared.stepCount).toBe(25);
    expect(cleared.cacheGeneration).toBe(2);
  });

  test("isolates identities, validates ownership, and rejects contained-resource violations", async () => {
    const service = createModReflectionPolicy({
      backend: backend(["agent-a"]),
      surface: "local",
      hostKey: "host-local",
      persistence: persistence(),
    });
    const other = { ...identity, agentId: "agent-b" };
    await expect(service.get(other)).rejects.toThrow("outside host scope");
    await expect(
      service.get({ ...identity, hostKey: "other" }),
    ).rejects.toThrow("not owned");
    await expect(
      service.update(identity, {
        definition: {
          content: "---\n---\nuses ../secret",
          ownership: "bootstrap",
        },
      }),
    ).rejects.toThrow("traversal");
    const second = await service.update(identity, {
      definition: {
        content: "---\nmodel: inherit\n---\nprivate",
        ownership: "bootstrap",
      },
    });
    expect(second.definitionOwnership).toBe("bootstrap");
    expect(
      (await service.get({ ...identity, agentId: "agent-a" })).definitionHash,
    ).toBe(second.definitionHash);
  });

  test("resolves requested agents only after validating parent scope", async () => {
    const resolver = createModReflectionIdentityResolver({
      hostKey: "opaque-host",
      surface: "local",
      validateAgent: async (agentId) => {
        if (agentId !== "agent-a") throw new Error("agent is outside host scope");
      },
    });
    expect(await resolver.get("agent-a")).toEqual({
      hostKey: "opaque-host",
      surface: "local",
      agentId: "agent-a",
    });
    await expect(resolver.get("agent-b")).rejects.toThrow("outside host scope");
  });

  test("survives a policy service restart through host-owned persistence", async () => {
    const durable = persistence();
    const first = createModReflectionPolicy({ backend: backend(["agent-a"]), surface: "local", hostKey: "restart", persistence: durable });
    await first.update({ ...identity, hostKey: "restart" }, { trigger: "compaction-event", model: "provider/model" });
    const second = createModReflectionPolicy({ backend: backend(["agent-a"]), surface: "local", hostKey: "restart", persistence: durable });
    const restored = await second.get({ ...identity, hostKey: "restart" });
    expect(restored.trigger).toBe("compaction-event");
    expect(restored.model).toBe("provider/model");
  });

  test("reports inherited model locally and unavailable model when explicit model capability is absent", async () => {
    const local = createModReflectionPolicy({
      backend: backend(["agent-a"]),
      surface: "local",
      hostKey: "local",
      persistence: persistence(),
    });
    expect(
      (await local.get({ ...identity, hostKey: "local" })).modelBehavior,
    ).toBe("inherited");
    const api = createModReflectionPolicy({
      backend: backend(["agent-a"]),
      surface: "api",
      hostKey: "api",
      persistence: persistence(),
      capabilities: { explicitModel: false },
    });
    const apiIdentity = {
      agentId: "agent-a",
      hostKey: "api",
      surface: "api" as const,
    };
    const result = await api.update(apiIdentity, { model: "provider/model" });
    expect(result.modelBehavior).toBe("inherited");
    expect(result.diagnostics).toHaveLength(0);
    const explicitApi = createModReflectionPolicy({
      backend: backend(["agent-a"]),
      surface: "api",
      hostKey: "api-explicit",
      persistence: persistence(),
    });
    const explicit = await explicitApi.update(
      { ...apiIdentity, hostKey: "api-explicit" },
      { model: "provider/model" },
    );
    expect(explicit.modelBehavior).toBe("explicit");
  });
});
