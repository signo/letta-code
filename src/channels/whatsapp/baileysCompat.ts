/**
 * Baileys compatibility boundary — single source of truth for Baileys
 * internal shape access that varies across versions.
 *
 * Consumers (jid.ts, session.ts, adapter.ts) must go through this module
 * instead of reaching into raw Baileys objects directly. This ensures that
 * when the Baileys API changes (e.g. v7 LID primacy, structured lidMapping),
 * only this file needs updating.
 *
 * Design rules:
 * - Return raw values; let callers (jid.ts) normalize.
 * - Do not import from jid.ts to avoid circular dependencies.
 * - Keep runtime loader redesign out of scope.
 */

// ─── LID mapping types ──────────────────────────────────────────────────────

/**
 * All supported shapes for signalRepository.lidMapping across Baileys versions:
 * - v6: Map<string, string>
 * - v6 (observed): plain Record<string, string>
 * - v6 (observed): object with a .get() method
 * - v7: structured object with getPNForLID() method
 */
export type BaileysLidMapping =
  | Map<string, string>
  | Record<string, string>
  | { get?: (key: string) => string | undefined }
  | { getPNForLID?: (lid: string) => string | undefined };

/** Socket subset relevant to LID resolution. */
export type BaileysSocketLike = {
  signalRepository?: {
    lidMapping?: BaileysLidMapping;
  };
};

// ─── SSOT: raw LID → PN lookup ──────────────────────────────────────────────

/**
 * Look up a raw LID→PN value from signalRepository.lidMapping.
 *
 * Handles all observed Baileys shapes: Map, Record, .get() object, and
 * v7-style getPNForLID() method. Returns the raw string value (may be a
 * phone JID, a phone number, or undefined).
 *
 * Callers should normalize the result via their own jid helpers.
 */
export function lookupLidMapping(
  sock: unknown,
  lidKey: string,
): string | undefined {
  const repo = (sock as BaileysSocketLike | undefined)?.signalRepository;
  const mapping = repo?.lidMapping;
  if (!mapping) return undefined;

  // v7 structured API takes priority
  if (
    typeof (mapping as { getPNForLID?: unknown }).getPNForLID === "function"
  ) {
    return (mapping as { getPNForLID: (lid: string) => string | undefined })
      .getPNForLID(lidKey);
  }

  // Map instance
  if (mapping instanceof Map) {
    return mapping.get(lidKey);
  }

  // Object with .get() method (some v6 builds)
  if (
    typeof mapping === "object" &&
    typeof (mapping as { get?: unknown }).get === "function"
  ) {
    return (mapping as { get: (key: string) => string | undefined }).get(
      lidKey,
    );
  }

  // Plain Record / object
  if (typeof mapping === "object") {
    return (mapping as Record<string, string>)[lidKey];
  }

  return undefined;
}
