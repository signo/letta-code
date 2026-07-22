import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend } from "@/backend";
import type {
  EffectiveReflectionPolicy,
  ModReflectionPolicy,
  ReflectionAgentIdentity,
  ReflectionCapabilityDescriptor,
  ReflectionDefinitionOwnership,
  ReflectionDefinitionSource,
  ReflectionPolicyPatch,
  ReflectionPolicyPersistence,
  ReflectionSurface,
} from "@/mods/backend-reflection-policy-types";

export * from "@/mods/backend-reflection-policy-types";

export function createModReflectionIdentityResolver(options: {
  hostKey: string;
  surface: ReflectionSurface;
  validateAgent: (agentId: string) => Promise<unknown>;
}): import("@/mods/backend-reflection-policy-types").ModReflectionIdentityResolver {
  if (!options.hostKey) throw new Error("Reflection identity requires a host-owned hostKey");
  return Object.freeze({
    async get(agentId: string) {
      if (typeof agentId !== "string" || !agentId.trim())
        throw new Error("Reflection identity requires an agentId");
      await options.validateAgent(agentId);
      return Object.freeze({ agentId, hostKey: options.hostKey, surface: options.surface });
    },
  });
}

const BUILT_IN_DEFINITION = "---\nname: reflection\nmodel: inherit\n---\n";
const DEFAULT_CAPABILITIES: ReflectionCapabilityDescriptor = Object.freeze({
  agentTriggerCadence: true,
  agentDefinition: true,
  explicitModel: true,
  effectiveReadBack: true,
  cacheInvalidation: true,
  local: true,
  api: true,
});

type DefinitionLayers = {
  project?: string;
  global?: string;
};

export type ReflectionPolicyBackendOptions = {
  readonly surface: ReflectionSurface;
  readonly hostKey?: string;
  readonly capabilities?: Partial<ReflectionCapabilityDescriptor>;
  readonly definitions?: DefinitionLayers;
  readonly definitionPaths?: { project?: string; global?: string };
  readonly builtInDefinition?: string;
  readonly defaultStepCount?: number;
  readonly persistence?: ReflectionPolicyPersistence;
};


function identityKey(identity: ReflectionAgentIdentity): string {
  return `${identity.hostKey}\u0000${identity.surface}\u0000${identity.agentId}`;
}

function assertIdentity(
  identity: ReflectionAgentIdentity,
  surface: ReflectionSurface,
  hostKey: string,
): void {
  if (
    !identity ||
    identity.surface !== surface ||
    identity.hostKey !== hostKey ||
    !identity.agentId.trim()
  ) {
    throw new Error(
      "Reflection policy identity is not owned by this host scope",
    );
  }
}

function canonicalContent(content: string): string {
  if (typeof content !== "string" || content.length === 0)
    throw new Error("Reflection definition content cannot be empty");
  const normalized = content.replaceAll("\r\n", "\n");
  if (
    /^\s*(?:[A-Za-z]:[\\/]|\/)/m.test(normalized) ||
    /(?:^|[\s=(])\.\.\//.test(normalized)
  ) {
    throw new Error(
      "Reflection definition contains an absolute or traversal resource reference",
    );
  }
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (frontmatter) {
    const model = frontmatter[1]?.match(/^model:\s*(\S+)\s*$/m)?.[1];
    if (model && model !== "inherit" && !/^[\w.-]+\/[\w.@:+-]+$/.test(model)) {
      throw new Error("Reflection definition model frontmatter is invalid");
    }
  }
  return normalized;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function definitionModel(content: string): string | null {
  return content.match(/^model:\s*(\S+)\s*$/m)?.[1] ?? "inherit";
}

function freezePolicy(
  policy: EffectiveReflectionPolicy,
): EffectiveReflectionPolicy {
  return Object.freeze({
    ...policy,
    identity: Object.freeze({ ...policy.identity }),
    diagnostics: Object.freeze([...policy.diagnostics]),
    explicitFields: policy.explicitFields
      ? Object.freeze([...policy.explicitFields])
      : undefined,
  });
}

export function createModReflectionPolicy(
  options: ReflectionPolicyBackendOptions & { readonly backend: Backend },
): ModReflectionPolicy {
  if (!options.hostKey) throw new Error("Reflection policy requires a host-owned hostKey");
  const hostKey = options.hostKey;
  const surface = options.surface;
  const persistence = options.persistence;
  const definitionsCache = new Map<string, string>();
  let cacheGeneration = 0;
  const builtIn = canonicalContent(
    options.builtInDefinition ?? BUILT_IN_DEFINITION,
  );
  const capability: ReflectionCapabilityDescriptor = Object.freeze({
    ...DEFAULT_CAPABILITIES,
    ...options.capabilities,
    local: options.capabilities?.local ?? surface === "local",
    api: options.capabilities?.api ?? surface === "api",
  });
  const definitions = options.definitions ?? {};
  const paths = options.definitionPaths ?? {};

  async function sharedDefinition(
    kind: "project" | "global",
  ): Promise<string | undefined> {
    const cacheKey = `${hostKey}\u0000${surface}\u0000${kind}`;
    const cached = definitionsCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const configured = definitions[kind];
    if (configured !== undefined) {
      const content = canonicalContent(configured);
      definitionsCache.set(cacheKey, content);
      return content;
    }
    const path = paths[kind];
    if (!path) return undefined;
    try {
      const content = canonicalContent(await readFile(path, "utf8"));
      definitionsCache.set(cacheKey, content);
      return content;
    } catch {
      return undefined;
    }
  }

  async function get(
    agent: ReflectionAgentIdentity,
  ): Promise<EffectiveReflectionPolicy> {
    assertIdentity(agent, surface, hostKey);
    await options.backend.retrieveAgent(agent.agentId);
    const explicit = persistence?.read(identityKey(agent));
    const project = await sharedDefinition("project");
    const global = await sharedDefinition("global");
    const definition =
      explicit?.definition?.content ?? project ?? global ?? builtIn;
    const definitionSource: ReflectionDefinitionSource = explicit?.definition
      ? "explicit-agent"
      : project
        ? "project"
        : global
          ? "global"
          : "built-in";
    const generation = cacheGeneration;
    const model = explicit?.model ?? definitionModel(definition);
    const modelBehavior =
      model === "inherit"
        ? "inherited"
        : model && capability.explicitModel
          ? "explicit"
          : "unavailable";
    const diagnostics = [
      ...(modelBehavior === "unavailable"
        ? [
            {
              code: "model-unavailable",
              message: "Reflection model cannot be resolved on this surface",
              field: "model" as const,
            },
          ]
        : []),
      ...(!capability.agentTriggerCadence
        ? [
            {
              code: "trigger-read-only",
              message:
                "Agent trigger and cadence are read-only on this surface",
              field: "trigger" as const,
            },
          ]
        : []),
      ...(!capability.agentDefinition
        ? [
            {
              code: "definition-read-only",
              message: "Agent definition is read-only on this surface",
              field: "definition" as const,
            },
          ]
        : []),
    ];
    return freezePolicy({
      identity: agent,
      trigger: explicit?.trigger ?? "step-count",
      stepCount: explicit?.stepCount ?? options.defaultStepCount ?? 25,
      definitionSource,
      definitionHash: hash(definition),
      cacheGeneration: generation,
      definitionOwnership:
        explicit?.definition?.ownership ??
        ("none" as ReflectionDefinitionOwnership),
      modelBehavior,
      model:
        modelBehavior === "inherited"
          ? null
          : modelBehavior === "explicit"
            ? model
            : null,
      explicitFields: explicit
        ? (Object.keys(explicit) as Array<
            "trigger" | "stepCount" | "definition" | "model"
          >)
        : [],
      diagnostics,
    });
  }

  async function update(
    agent: ReflectionAgentIdentity,
    patch: ReflectionPolicyPatch,
  ): Promise<EffectiveReflectionPolicy> {
    assertIdentity(agent, surface, hostKey);
    await options.backend.retrieveAgent(agent.agentId);
    const key = identityKey(agent);
    const current = { ...(persistence?.read(key) ?? {}) };
    if (patch.trigger !== undefined && capability.agentTriggerCadence) {
      if (patch.trigger === null) delete current.trigger;
      else current.trigger = patch.trigger;
    }
    if (patch.stepCount !== undefined && capability.agentTriggerCadence) {
      if (
        patch.stepCount !== null &&
        (!Number.isInteger(patch.stepCount) || patch.stepCount < 1)
      )
        throw new Error("Reflection stepCount must be a positive integer");
      if (patch.stepCount === null) delete current.stepCount;
      else current.stepCount = patch.stepCount;
    }
    if (patch.definition !== undefined && capability.agentDefinition) {
      // Bootstrap is create-if-missing: once a definition exists, it is user-owned.
      if (patch.definition === null) delete current.definition;
      else if (
        patch.definition.ownership !== "bootstrap" ||
        !current.definition
      ) {
        current.definition = {
          content: canonicalContent(patch.definition.content),
          ownership: patch.definition.ownership,
        };
      }
    }
    if (patch.model !== undefined && capability.explicitModel) {
      if (patch.model === null) delete current.model;
      else
        current.model =
          patch.model.trim() ||
          (() => {
            throw new Error("Reflection model cannot be empty");
          })();
    }
    const changed =
      (patch.trigger !== undefined && capability.agentTriggerCadence) ||
      (patch.stepCount !== undefined && capability.agentTriggerCadence) ||
      (patch.definition !== undefined && capability.agentDefinition) ||
      (patch.model !== undefined && capability.explicitModel);
    if (changed) {
      persistence?.write(key, Object.keys(current).length ? current : undefined);
      definitionsCache.clear();
      cacheGeneration += 1;
    }
    return get(agent);
  }

  return Object.freeze({ capabilities: capability, get, update });
}

export function defaultReflectionDefinitionPaths(): {
  project: string;
  global: string;
} {
  return {
    project: join(process.cwd(), ".letta", "reflection.md"),
    global: join(process.env.HOME ?? "", ".letta", "agents", "reflection.md"),
  };
}
