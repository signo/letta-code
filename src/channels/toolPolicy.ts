/**
 * Per-account tool policy evaluation for channel turns.
 *
 * Uses wildcard semantics:
 *   - undefined → allow all by default
 *   - []        → deny all
 *   - ["*"]     → allow all
 *   - [explicit] → allowlist
 *
 * blockedTools always subtracts from the effective allowed set.
 *
 * Lists are normalized (trim, dedupe, collapse "*") before evaluation.
 */

import { matchesWildcardList, normalizeWildcardList } from "./wildcardList";

export interface ToolPolicy {
  allowedTools?: string[];
  blockedTools?: string[];
}

/**
 * Result of evaluating a tool against policy.
 * "allow"  → tool passes both allowlist and blocklist
 * "deny"   → tool is explicitly blocked or not on allowlist
 */
export type ToolPolicyDecision = "allow" | "deny";

/**
 * Evaluate whether a tool is allowed by the account's tool policy.
 *
 * Returns "allow" if the tool passes both the allowed and blocked lists,
 * "deny" otherwise.
 *
 * Lists are normalized on every call — safe for raw config input.
 */
export function evaluateToolPolicy(
  toolName: string,
  policy: ToolPolicy,
): ToolPolicyDecision {
  const blocked = normalizeWildcardList(policy.blockedTools);
  const allowed = normalizeWildcardList(policy.allowedTools);

  // blockedTools always subtracts — check first for fast-path deny.
  if (blocked.length > 0) {
    if (matchesWildcardList(blocked, toolName)) {
      return "deny";
    }
  }

  // allowedTools: undefined normalized to [] by normalizeWildcardList.
  // Original undefined means "allow all" (different from explicit []).
  if (policy.allowedTools === undefined) {
    return "allow";
  }

  // allowedTools: [] → deny all.
  if (allowed.length === 0) {
    return "deny";
  }

  // allowedTools: explicit list or ["*"].
  return matchesWildcardList(allowed, toolName) ? "allow" : "deny";
}

/**
 * Build a user-visible reason for a tool policy denial.
 */
export function formatToolPolicyDenial(toolName: string): string {
  return `Tool "${toolName}" is not permitted in this channel configuration.`;
}