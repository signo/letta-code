/**
 * Wildcard list semantics for policy-gated config lists.
 *
 * Rules (fail-closed):
 *   undefined  → deny all
 *   []         → deny all
 *   ["*"]      → allow all
 *   [explicit] → explicit allowlist
 *
 * Normalization: trim entries, dedupe, collapse "*" to ["*"].
 */

/**
 * Normalize a string list for wildcard semantics.
 * - Trims whitespace from each entry
 * - Removes empty strings after trim
 * - Deduplicates
 * - If "*" is present, collapses to ["*"]
 */
export function normalizeWildcardList(list: string[] | undefined): string[] {
  if (!list || list.length === 0) return [];

  const trimmed = list.map((s) => s.trim()).filter((s) => s.length > 0);
  const deduped = [...new Set(trimmed)];

  if (deduped.includes("*")) return ["*"];
  return deduped;
}

/**
 * Check if a value matches a wildcard list.
 * - []       → always false (deny all)
 * - ["*"]    → always true (allow all)
 * - [values] → true if value is in the list (case-sensitive exact match)
 */
export function matchesWildcardList(list: string[], value: string): boolean {
  if (list.length === 0) return false;
  if (list.length === 1 && list[0] === "*") return true;
  return list.includes(value);
}