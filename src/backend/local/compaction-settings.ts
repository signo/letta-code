import { isUnselectedLocalModelHandle } from "@/backend/dev/pi-model-factory";
import { isRecord } from "@/utils/type-guards";
import type { LocalCompactionMode } from "./compaction";

/**
 * Raw compaction-settings record shape used by the local backend. Kept loose
 * (record of unknown) because request/agent compaction settings arrive from
 * untyped API surfaces and are validated/normalized downstream.
 */
export type LocalCompactionSettingsRecord = Record<string, unknown>;

/**
 * Fully resolved compaction settings for a single compaction operation. The
 * local backend computes these from request + agent compaction settings.
 */
export interface ResolvedLocalCompactionSettings {
  mode: LocalCompactionMode;
  prompt?: string | null;
  clipChars?: number | null;
  slidingWindowPercentage: number;
  /**
   * U3 explicit compaction model. Precedence: request compaction override →
   * agent compaction setting → undefined (preserve conversation-model
   * behavior). Invalid explicit models fail visibly at execution time.
   */
  compactionModel?: string | null;
}

/**
 * Coerce a raw compaction-settings value into a plain record. `null` is
 * preserved (explicit clear); non-record values become `undefined` (absent).
 */
export function compactionSettingsRecord(
  value: unknown,
): LocalCompactionSettingsRecord | null | undefined {
  if (value === null) return null;
  return isRecord(value) ? { ...value } : undefined;
}

/**
 * Normalize a raw compaction mode value into the supported local modes.
 */
export function localCompactionMode(
  value: unknown,
): LocalCompactionMode | undefined {
  if (value === "all" || value === "sliding_window") return value;
  return undefined;
}

/**
 * U3: normalize an explicit compaction model value. A non-empty string (after
 * trimming) that is not an unselected/local-default handle is returned as-is;
 * `null` clears explicitly; an empty/whitespace string or any other absent
 * value yields `undefined` so the next precedence layer (or the conversation
 * model) applies. We do not validate the model exists here — invalid explicit
 * models must fail visibly at execution.
 */
export function resolveExplicitCompactionModel(
  value: unknown,
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (isUnselectedLocalModelHandle(trimmed)) return undefined;
  return trimmed;
}

/**
 * U3: resolve the explicit compaction model from request and agent compaction
 * settings. Precedence is request override → agent compaction setting →
 * `undefined` (preserve conversation-model behavior). `null` at the winning
 * layer clears explicitly; an empty/whitespace or unselected value is treated
 * as absent and falls through to the next layer. Pure/unit-testable;
 * `resolveCompactionSettings` applies the same logic.
 */
export function resolveCompactionModelPrecedence(
  requestSettings: Record<string, unknown> | null | undefined,
  agentSettings: Record<string, unknown> | null | undefined,
): string | null | undefined {
  if (requestSettings && Object.hasOwn(requestSettings, "model")) {
    const requestModel = resolveExplicitCompactionModel(requestSettings.model);
    // An empty/unselected request model is "not set": fall through to the
    // agent layer rather than clearing. Only an explicit `null` clears.
    if (requestModel !== undefined) return requestModel;
  }
  if (agentSettings && Object.hasOwn(agentSettings, "model")) {
    return resolveExplicitCompactionModel(agentSettings.model);
  }
  return undefined;
}

/**
 * Validate a raw compaction-settings record. Throws if `mode` is present but
 * not a supported local compaction mode.
 */
export function validateLocalCompactionSettingsRecord(
  settings: LocalCompactionSettingsRecord,
): void {
  if (settings.mode === undefined || settings.mode === null) return;
  if (!localCompactionMode(settings.mode)) {
    throw new Error(
      `Local backend compaction currently supports only modes "all" and "sliding_window" (received "${String(
        settings.mode,
      )}").`,
    );
  }
}

/**
 * Normalize raw compaction settings for storage. Returns `undefined` when the
 * record carries no managed compaction field (so the storage write is skipped),
 * `null` to clear explicitly, or the record as-is otherwise.
 *
 * U3: `model` is a first-class managed compaction setting. Without it in this
 * presence check, a model-only update (e.g. `{ model: "..." }`) is treated as
 * "no managed setting" and the storage write is skipped, silently dropping the
 * model override. Include it so any single managed field — including a
 * model-only update — is persisted.
 */
export function localCompactionSettingsForStorage(
  settings: LocalCompactionSettingsRecord | null | undefined,
): LocalCompactionSettingsRecord | null | undefined {
  if (settings === undefined || settings === null) return settings;

  const hasLocalSetting =
    Object.hasOwn(settings, "mode") ||
    Object.hasOwn(settings, "prompt") ||
    Object.hasOwn(settings, "clip_chars") ||
    Object.hasOwn(settings, "sliding_window_percentage") ||
    Object.hasOwn(settings, "model");
  if (!hasLocalSetting) return undefined;

  return { ...settings };
}
