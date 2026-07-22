export type ReflectionTrigger = "off" | "step-count" | "compaction-event";
export type ReflectionSurface = "local" | "api";
export type ReflectionDefinitionSource =
  | "explicit-agent"
  | "project"
  | "global"
  | "built-in";
export type ReflectionDefinitionOwnership = "none" | "managed" | "bootstrap";
export type ReflectionModelBehavior = "inherited" | "explicit" | "unavailable";

export type ReflectionAgentIdentity = Readonly<{
  agentId: string;
  hostKey: string;
  surface: ReflectionSurface;
}>;

export interface ModReflectionIdentityResolver {
  /** Resolve an agent identity after the host validates it is in parent scope. */
  get(agentId: string): Promise<ReflectionAgentIdentity>;
}

export type ReflectionPolicyPersistence = {
  read(agentKey: string): ExplicitReflectionPolicy | undefined;
  write(agentKey: string, policy: ExplicitReflectionPolicy | undefined): void;
};

export type ExplicitReflectionPolicy = Readonly<{
  trigger?: ReflectionTrigger;
  stepCount?: number;
  definition?: ReflectionDefinition;
  model?: string;
}>;
export type ReflectionDefinition = Readonly<{
  content: string;
  ownership: "managed" | "bootstrap";
}>;
export type ReflectionPolicyPatch = Readonly<{
  trigger?: ReflectionTrigger | null;
  stepCount?: number | null;
  definition?: ReflectionDefinition | null;
  model?: string | null;
}>;
export type ReflectionCapabilityDescriptor = Readonly<{
  agentTriggerCadence: boolean;
  agentDefinition: boolean;
  explicitModel: boolean;
  effectiveReadBack: boolean;
  cacheInvalidation: boolean;
  local: boolean;
  api: boolean;
}>;
export type EffectiveReflectionPolicy = Readonly<{
  identity: ReflectionAgentIdentity;
  trigger: ReflectionTrigger;
  stepCount: number;
  definitionSource: ReflectionDefinitionSource;
  definitionHash: string;
  cacheGeneration: number;
  definitionOwnership: ReflectionDefinitionOwnership;
  modelBehavior: ReflectionModelBehavior;
  model: string | null;
  explicitFields?: readonly (
    | "trigger"
    | "stepCount"
    | "definition"
    | "model"
  )[];
  diagnostics: readonly Readonly<{
    code: string;
    message: string;
    field?: "trigger" | "stepCount" | "definition" | "model";
  }>[];
}>;
export interface ModReflectionPolicy {
  readonly capabilities: ReflectionCapabilityDescriptor;
  get(agent: ReflectionAgentIdentity): Promise<EffectiveReflectionPolicy>;
  update(
    agent: ReflectionAgentIdentity,
    patch: ReflectionPolicyPatch,
  ): Promise<EffectiveReflectionPolicy>;
}
