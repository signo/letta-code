import type {
  AgentUpdateBody,
  Backend,
  BackendAgentAdminCapabilities,
} from "@/backend";
import { settingsManager } from "@/settings-manager";
import {
  createModReflectionIdentityResolver,
  createModReflectionPolicy,
  type ModReflectionPolicy,
} from "@/mods/backend-reflection-policy";

export type ModJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly ModJsonValue[]
  | ModJsonObject;

export interface ModJsonObject {
  readonly [key: string]: ModJsonValue;
}

export interface ModAgentListOptions {
  readonly after?: string | null;
  readonly before?: string | null;
  readonly limit?: number | null;
  readonly queryText?: string | null;
  readonly signal?: AbortSignal;
  readonly tags?: readonly string[] | null;
}

export interface ModAgentRetrieveOptions {
  readonly signal?: AbortSignal;
}

export interface ModCompactionSettings {
  readonly clipChars: number | null;
  readonly mode: string | null;
  readonly model: string | null;
  readonly modelSettings: ModJsonObject | null;
}

export interface ModCompactionSettingsPatch {
  readonly clipChars?: number | null;
  readonly mode?: string | null;
  readonly model?: string | null;
  readonly modelSettings?: ModJsonObject | null;
}

export interface ModAgentUpdatePatch {
  readonly compactionSettings?: ModCompactionSettingsPatch | null;
  readonly description?: string | null;
  readonly enableSleeptime?: boolean | null;
  readonly hidden?: boolean | null;
  readonly model?: string | null;
  readonly modelSettings?: ModJsonObject | null;
  readonly name?: string | null;
  readonly tags?: readonly string[] | null;
}

export interface ModAgentRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly model: string | null;
  readonly modelSettings: ModJsonObject | null;
  readonly compactionSettings: ModCompactionSettings | null;
  readonly enableSleeptime: boolean | null;
  readonly hidden: boolean | null;
  readonly tags: readonly string[];
}

export interface ModAgentListPage {
  readonly hasMore: boolean;
  readonly items: readonly ModAgentRecord[];
  readonly nextPage: (() => Promise<ModAgentListPage>) | null;
}

export interface ModAgentAdminV1 {
  readonly apiVersion: 1;
  readonly capabilities: {
    readonly list: true;
    readonly retrieve: true;
    readonly update: true;
    readonly create: false;
    readonly delete: false;
    readonly compaction: {
      readonly explicitModel: boolean;
    };
  };
  list(options?: ModAgentListOptions): Promise<ModAgentListPage>;
  retrieve(
    agentId: string,
    options?: ModAgentRetrieveOptions,
  ): Promise<ModAgentRecord>;
  update(
    agentId: string,
    patch: ModAgentUpdatePatch,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ModAgentRecord>;
}

export interface ModBackendApi {
  readonly agentAdmin?: ModAgentAdminV1;
  readonly reflectionPolicy?: ModReflectionPolicy;
  readonly reflectionIdentity?: import("@/mods/backend-reflection-policy-types").ModReflectionIdentityResolver;
}

interface CreateModAgentAdminOptions {
  getBackend: () => Backend | undefined;
  isLive: () => boolean;
  signal: AbortSignal;
}

export interface CreateModBackendApiOptions {
  getBackend?: () => Backend | undefined;
  isLive: () => boolean;
  signal: AbortSignal;
}

const AGENT_UPDATE_FIELDS = new Set([
  "compactionSettings",
  "description",
  "enableSleeptime",
  "hidden",
  "model",
  "modelSettings",
  "name",
  "tags",
]);

function createAbortError(): Error {
  const error = new Error(
    "Active-backend agent administration request aborted",
  );
  error.name = "AbortError";
  return error;
}

function assertRequestLive(
  isLive: () => boolean,
  ownerSignal: AbortSignal,
  requestSignal?: AbortSignal,
): void {
  if (!isLive() || ownerSignal.aborted || requestSignal?.aborted) {
    throw createAbortError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeJsonValue(value: unknown, path: string): ModJsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`)),
    );
  }
  if (!isPlainRecord(value)) {
    throw new Error(`${path} must contain only plain JSON values`);
  }
  const result: Record<string, ModJsonValue> = {};
  for (const key of Object.keys(value)) {
    result[key] = normalizeJsonValue(value[key], `${path}.${key}`);
  }
  return Object.freeze(result);
}

function normalizeJsonObject(
  value: unknown,
  path: string,
): ModJsonObject | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizeJsonValue(value, path);
  if (!isRecord(normalized) || Array.isArray(normalized)) {
    throw new Error(`${path} must be a plain object`);
  }
  return normalized;
}

function optionalString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    throw new Error(`${path} must be a string or null`);
  return value;
}

function optionalFiniteNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number or null`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean")
    throw new Error(`${path} must be a boolean or null`);
  return value;
}

function normalizeTags(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return Object.freeze([...value]);
}

function normalizeCompactionSettings(
  value: unknown,
): ModCompactionSettings | null {
  if (value === null || value === undefined) return null;
  if (!isPlainRecord(value)) {
    throw new Error("compactionSettings must be a plain object or null");
  }
  const allowed = new Set(["clip_chars", "mode", "model", "model_settings"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`Unsupported compaction setting '${key}'`);
  }
  return Object.freeze({
    clipChars: optionalFiniteNumber(
      value.clip_chars,
      "compaction_settings.clip_chars",
    ),
    mode: optionalString(value.mode, "compaction_settings.mode"),
    model: optionalString(value.model, "compaction_settings.model"),
    modelSettings: normalizeJsonObject(
      value.model_settings,
      "compaction_settings.model_settings",
    ),
  });
}

function normalizeAgent(value: unknown): ModAgentRecord {
  if (!isRecord(value))
    throw new Error("Active-backend agent result is invalid");
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error("Active-backend agent result has an invalid id");
  }
  if (typeof value.name !== "string") {
    throw new Error("Active-backend agent result has an invalid name");
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    description: optionalString(value.description, "agent.description"),
    model: optionalString(value.model, "agent.model"),
    modelSettings: normalizeJsonObject(
      value.model_settings,
      "agent.model_settings",
    ),
    compactionSettings: normalizeCompactionSettings(value.compaction_settings),
    enableSleeptime: optionalBoolean(
      value.enable_sleeptime,
      "agent.enable_sleeptime",
    ),
    hidden: optionalBoolean(value.hidden, "agent.hidden"),
    tags: normalizeTags(value.tags ?? [], "agent.tags"),
  });
}

function getPageItems(value: unknown): unknown[] {
  if (!isRecord(value)) {
    throw new Error("Active-backend agent list returned an invalid page");
  }
  const getPaginatedItems = value.getPaginatedItems;
  const items =
    typeof getPaginatedItems === "function"
      ? getPaginatedItems.call(value)
      : value.items;
  if (!Array.isArray(items)) {
    throw new Error("Active-backend agent list returned invalid items");
  }
  return items;
}

function getPageLastId(items: readonly unknown[]): string | null {
  const last = items.at(-1);
  return isRecord(last) && typeof last.id === "string" ? last.id : null;
}

function normalizeListPage(
  value: unknown,
  loadFallbackPage?: () => Promise<unknown>,
  beforeNextPage?: () => void,
): ModAgentListPage {
  const rawItems = getPageItems(value);
  const items = Object.freeze(rawItems.map((item) => normalizeAgent(item)));
  const getNextPage = isRecord(value) ? value.getNextPage : undefined;
  const hasNextPage = isRecord(value) ? value.hasNextPage : undefined;
  const sdkHasNext =
    typeof getNextPage === "function" &&
    typeof hasNextPage === "function" &&
    hasNextPage.call(value);
  const loadSdkNextPage = sdkHasNext
    ? () => getNextPage.call(value)
    : undefined;
  const loadNextPage = loadSdkNextPage ?? loadFallbackPage;
  const hasMore = loadNextPage !== undefined;
  return Object.freeze({
    hasMore,
    items,
    nextPage: hasMore
      ? async () => {
          beforeNextPage?.();
          return normalizeListPage(
            await loadNextPage(),
            undefined,
            beforeNextPage,
          );
        }
      : null,
  });
}

function normalizeListOptions(
  options?: ModAgentListOptions,
): Record<string, unknown> {
  if (!options) return {};
  const { after, before, limit, queryText, tags } = options;
  if (
    limit !== undefined &&
    limit !== null &&
    (!Number.isInteger(limit) || limit < 1)
  ) {
    throw new Error("Agent list limit must be a positive integer or null");
  }
  return {
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(queryText !== undefined ? { query_text: queryText } : {}),
    ...(tags !== undefined ? { tags: tags === null ? null : [...tags] } : {}),
  };
}

function normalizeCompactionPatch(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) {
    throw new Error("compactionSettings must be a plain object or null");
  }
  const allowed = new Set(["clipChars", "mode", "model", "modelSettings"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`Unsupported compaction patch field '${key}'`);
  }
  const result: Record<string, unknown> = {};
  if ("clipChars" in value) {
    result.clip_chars = optionalFiniteNumber(
      value.clipChars,
      "compactionSettings.clipChars",
    );
  }
  if ("mode" in value)
    result.mode = optionalString(value.mode, "compactionSettings.mode");
  if ("model" in value)
    result.model = optionalString(value.model, "compactionSettings.model");
  if ("modelSettings" in value) {
    result.model_settings = normalizeJsonObject(
      value.modelSettings,
      "compactionSettings.modelSettings",
    );
  }
  return result;
}

function normalizeUpdatePatch(value: unknown): AgentUpdateBody {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) {
    throw new Error("Agent update requires a non-empty plain object patch");
  }
  for (const key of Object.keys(value)) {
    if (!AGENT_UPDATE_FIELDS.has(key) || value[key] === undefined) {
      throw new Error(`Agent update field '${key}' is not supported`);
    }
  }
  const result: AgentUpdateBody = {};
  if ("compactionSettings" in value) {
    result.compaction_settings = normalizeCompactionPatch(
      value.compactionSettings,
    );
  }
  if ("description" in value) {
    result.description = optionalString(value.description, "description");
  }
  if ("enableSleeptime" in value) {
    result.enable_sleeptime = optionalBoolean(
      value.enableSleeptime,
      "enableSleeptime",
    );
  }
  if ("hidden" in value)
    result.hidden = optionalBoolean(value.hidden, "hidden");
  if ("model" in value) result.model = optionalString(value.model, "model");
  if ("modelSettings" in value) {
    result.model_settings = normalizeJsonObject(
      value.modelSettings,
      "modelSettings",
    );
  }
  if ("name" in value) result.name = optionalString(value.name, "name");
  if ("tags" in value) {
    result.tags =
      value.tags === null ? null : [...normalizeTags(value.tags, "tags")];
  }
  return result;
}

function validateAgentId(agentId: string): void {
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    throw new Error("Active-backend agent administration requires an agent id");
  }
}

function getActiveBackend(getBackend: () => Backend | undefined): Backend {
  const backend = getBackend();
  if (!isBackendAgentAdminSupported(backend?.capabilities.agentAdmin)) {
    throw new Error("Active-backend agent administration is unavailable");
  }
  return backend;
}

export function isBackendAgentAdminSupported(
  value: unknown,
): value is BackendAgentAdminCapabilities {
  if (!isRecord(value)) return false;
  return (
    value.list === true && value.retrieve === true && value.update === true
  );
}

export function createModAgentAdmin(
  options: CreateModAgentAdminOptions,
): ModAgentAdminV1 {
  const { getBackend, isLive, signal } = options;
  const explicitCompactionModel =
    getBackend?.()?.capabilities?.compaction?.explicitModel === true;
  return Object.freeze({
    apiVersion: 1 as const,
    capabilities: Object.freeze({
      list: true as const,
      retrieve: true as const,
      update: true as const,
      create: false as const,
      delete: false as const,
      compaction: Object.freeze({
        explicitModel: explicitCompactionModel,
      }),
    }),
    async list(requestOptions?: ModAgentListOptions) {
      const requestSignal = requestOptions?.signal;
      assertRequestLive(isLive, signal, requestSignal);
      const backend = getActiveBackend(getBackend);
      const body = normalizeListOptions(requestOptions);
      const page = await backend.listAgents(body);
      assertRequestLive(isLive, signal, requestSignal);
      const limit = requestOptions?.limit;
      const rawItems = getPageItems(page);
      const lastId = getPageLastId(rawItems);
      const sdkPaged =
        isRecord(page) &&
        typeof page.getNextPage === "function" &&
        typeof page.hasNextPage === "function";
      const loadFallbackPage =
        !sdkPaged &&
        limit !== undefined &&
        limit !== null &&
        rawItems.length >= limit &&
        lastId
          ? async () => {
              assertRequestLive(isLive, signal, requestSignal);
              return backend.listAgents({
                ...body,
                after: lastId,
                before: undefined,
              });
            }
          : undefined;
      return normalizeListPage(page, loadFallbackPage, () =>
        assertRequestLive(isLive, signal, requestSignal),
      );
    },
    async retrieve(agentId: string, requestOptions?: ModAgentRetrieveOptions) {
      const requestSignal = requestOptions?.signal;
      validateAgentId(agentId);
      assertRequestLive(isLive, signal, requestSignal);
      const backend = getActiveBackend(getBackend);
      const agent = await backend.retrieveAgent(agentId);
      assertRequestLive(isLive, signal, requestSignal);
      return normalizeAgent(agent);
    },
    async update(
      agentId: string,
      patch: ModAgentUpdatePatch,
      requestOptions?: { readonly signal?: AbortSignal },
    ) {
      const requestSignal = requestOptions?.signal;
      validateAgentId(agentId);
      assertRequestLive(isLive, signal, requestSignal);
      const backend = getActiveBackend(getBackend);
      const agent = await backend.updateAgent(
        agentId,
        normalizeUpdatePatch(patch),
      );
      assertRequestLive(isLive, signal, requestSignal);
      return normalizeAgent(agent);
    },
  });
}

export function createModBackendApi(
  options: CreateModBackendApiOptions,
): ModBackendApi {
  if (!options.getBackend) return Object.freeze({});
  const agentAdmin = createModAgentAdmin({
    getBackend: options.getBackend,
    isLive: options.isLive,
    signal: options.signal,
  });
  let reflectionPolicy: ModReflectionPolicy | undefined;
  let reflectionIdentity: ModBackendApi["reflectionIdentity"];
  let reflectionBackend: Backend | undefined;
  function getReflectionPolicy(): ModReflectionPolicy | undefined {
    const backend = options.getBackend?.();
    if (!backend || (!backend.capabilities.reflectionPolicy && !backend.capabilities.localMemfs)) return undefined;
    if (backend !== reflectionBackend) {
      reflectionBackend = backend;
      const surface = backend.capabilities.localMemfs ? "local" : "api";
      const hostKey = `letta-code:${settingsManager.getOrCreateDeviceId()}:${surface}`;
      reflectionPolicy = createModReflectionPolicy({
        backend,
        hostKey,
        surface,
        persistence: {
          read: (key) => settingsManager.getSettings().reflectionPolicies?.[key],
          write: (key, value) => {
            const policies = { ...(settingsManager.getSettings().reflectionPolicies ?? {}) };
            if (value) policies[key] = value;
            else delete policies[key];
            settingsManager.updateSettings({ reflectionPolicies: policies });
          },
        },
      });
      reflectionIdentity = createModReflectionIdentityResolver({
        hostKey,
        surface,
        validateAgent: async (agentId) => {
          await backend.retrieveAgent(agentId);
        },
      });
    }
    return reflectionPolicy;
  }
  return Object.freeze({
    get reflectionIdentity() {
      return getReflectionPolicy() ? reflectionIdentity : undefined;
    },
    get agentAdmin() {
      return isBackendAgentAdminSupported(
        options.getBackend?.()?.capabilities.agentAdmin,
      )
        ? agentAdmin
        : undefined;
    },
    get reflectionPolicy() {
      return getReflectionPolicy();
    },
  });
}
