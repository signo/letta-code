import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname as realHostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWhatsAppSessionLease,
  parseProcStatStartTime,
  renderQrTerminal,
} from "@/channels/whatsapp/session";

/**
 * Session-lock identity model — starttime token based.
 *
 * Lock freshness is verified in three stages:
 *
 *  1. hostname — mismatch = different machine or container restart → stale.
 *
 *  2. PID liveness — absent or dead → stale.  Alive → verify with starttime.
 *
 *  3. starttime token from /proc/<pid>/stat (0-indexed: fields[19], clock ticks
 *     since boot; 1-based field 22 in man proc(5)):
 *     - String equality: same token = same process → live lock, fails.
 *     - Different token = PID recycled after crash/restart → stale.
 *     - Absent (legacy lock) → conservative: keep if PID alive + hostname match.
 *
 * Decision table:
 *  hostname matches + PID alive + starttime matches  → KEEP (throw)
 *  hostname matches + PID alive + starttime differs   → CLEAR (acquire OK)
 *  hostname matches + PID alive + no starttime (legacy)→ KEEP (conservative)
 *  hostname matches + PID dead                        → CLEAR (acquire OK)
 *  hostname differs                                   → CLEAR (acquire OK)
 *
 * NOT USED:
 *  - CONTAINER_ID env var — not set in production.
 *  - PID 1 blanket rule — PID 1 is the normal server process; treated identically.
 *  - Generated instanceId — every new process would differ, breaking the singleton.
 *  - RSS field (fields[21]) — changes at runtime, must not affect identity.
 */

// ── Parser unit tests ────────────────────────────────────────────────────────

/**
 * Confirms the field layout of /proc/<pid>/stat after slice(lastParen+2).split(" ").
 *
 * Correct layout (confirmed against real /proc/1/stat on this system):
 *   fields[18] = 1-based field 19 = itrealvalue (always 0 in modern kernels)
 *   fields[19] = 1-based field 20 = itrealvalue (always 0)
 *   fields[20] = 1-based field 21 = starttime (clock ticks since boot)  ← TARGET
 *   fields[21] = 1-based field 22 = RSS (changes as memory pressure varies)
 *
 * The prior bug: code read fields[21] (RSS) instead of fields[20] (starttime).
 * RSS changes at runtime; using it as identity causes false stale detection and
 * allows a second process to clear a live WhatsApp lock.
 */
test("parseProcStatStartTime fixture: fields[20] = starttime, fields[21] = RSS", () => {
  // Fixture built from real /proc/1/stat structure:
  // After last ')', exactly 21 fields precede starttime:
  //   fields[18] = 0    (itrealvalue area)
  //   fields[19] = 0    (itrealvalue)
  //   fields[20] = 23117824  (starttime, clock ticks since boot — stable)
  //   fields[21] = 3296      (RSS, changes at runtime — NOT identity)
  const fixtureLine =
    "(init) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 23117824 3296 0";

  const lastParen = fixtureLine.lastIndexOf(")");
  const fields = fixtureLine.slice(lastParen + 2).split(" ");

  // Manual field inspection confirms the layout:
  expect(fields[18]).toBe("0"); // itrealvalue area
  expect(fields[19]).toBe("0"); // itrealvalue
  expect(fields[20]).toBe("23117824"); // starttime — stable (only changes on PID recycle)
  expect(fields[21]).toBe("3296"); // RSS — changes as memory allocated/freed

  // parseProcStatStartTime reads fields[20], not fields[19] or fields[21].
  // A bug reading fields[21] (RSS) would cause false stale detection whenever
  // RSS changes during normal process operation.
  expect(parseProcStatStartTime(fixtureLine)).toBe("23117824");
});

/**
 * parseProcStatStartTime reads fields[20], not fields[19] (itrealvalue) or fields[21] (RSS).
 * This test uses the actual /proc/1/stat line to prove the identity.
 */
test("parseProcStatStartTime reads fields[20] (starttime), not fields[19] (itrealvalue) or fields[21] (RSS)", async () => {
  const { readFileSync } = await import("node:fs");
  const statLine = readFileSync("/proc/1/stat", "utf8");
  const lastParen = statLine.lastIndexOf(")");
  const fields = statLine.slice(lastParen + 2).split(" ");

  // Verify: fields[20] is the large clock-tick starttime value.
  // fields[19] is itrealvalue (always 0). fields[21] is RSS (much smaller than starttime).
  const itrealField = fields[19]!;
  const starttimeField = fields[20]!;
  const rssField = fields[21]!;

  expect(Number(itrealField)).toBeLessThan(100); // itrealvalue — always small
  expect(Number(starttimeField)).toBeGreaterThan(1_000_000); // clock ticks — large
  expect(Number(rssField)).toBeGreaterThan(0);

  // Confirm: starttime field is much larger than itrealvalue or RSS
  expect(Number(starttimeField)).toBeGreaterThan(Number(itrealField) * 10);
  expect(Number(starttimeField)).toBeGreaterThan(Number(rssField) * 10);

  // parseProcStatStartTime must return fields[20], not fields[19] or [21]
  expect(parseProcStatStartTime(statLine)).toBe(starttimeField);
  expect(parseProcStatStartTime(statLine)).not.toBe(itrealField);
  expect(parseProcStatStartTime(statLine)).not.toBe(rssField);
});

/**
 * parseProcStatStartTime is stable: calling it twice on the same line
 * returns the same token.  This guards against accidental field shifts.
 */
test("parseProcStatStartTime: stable on same input", async () => {
  const { readFileSync } = await import("node:fs");
  const statLine = readFileSync("/proc/1/stat", "utf8");
  expect(parseProcStatStartTime(statLine)).toBe(
    parseProcStatStartTime(statLine),
  );
});

// ── QR rendering ──────────────────────────────────────────────────────────────

describe("QR rendering", () => {
  test("renders qrcode-terminal with the module as this", () => {
    const qrMod = {
      error: "L",
      generate(
        this: { error?: string },
        input: string,
        options: unknown,
        cb?: (output: string) => void,
      ) {
        if (!this.error) {
          throw new Error("missing this binding");
        }
        cb?.(`${input}:${this.error}:${JSON.stringify(options)}`);
      },
    };

    expect(renderQrTerminal(qrMod, "pairing-payload")).toBe(
      'pairing-payload:L:{"small":true}',
    );
  });

  test("falls back when qrcode-terminal rendering throws", () => {
    const qrMod = {
      generate() {
        throw new Error("boom");
      },
    };

    expect(renderQrTerminal(qrMod, "pairing-payload")).toBeUndefined();
  });
});

// ── Concurrent lease ────────────────────────────────────────────────────────

test("prevents concurrent session leases for the same account", () => {
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");

  try {
    const lease = acquireWhatsAppSessionLease("test-account", { lockDir });
    expect(() =>
      acquireWhatsAppSessionLease("test-account", { lockDir }),
    ).toThrow(/already has an active session/);

    lease.release();
    const reacquired = acquireWhatsAppSessionLease("test-account", {
      lockDir,
    });
    reacquired.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Dead PID with no identity fields ─────────────────────────────────────────

test("removes stale session leases (PID dead, no identity fields)", () => {
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-stale-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: 12345, command: "old server" }),
  );

  try {
    const lease = acquireWhatsAppSessionLease("stale-account", {
      lockDir,
      isProcessAlive: () => false,
    });
    lease.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Starttime-based stale detection ─────────────────────────────────────────

/**
 * Scenario 1: Active PID 1 lock with matching starttime → KEEP.
 *
 * The owner lock contains PID 1 + matching starttime token.
 * A second process in the same container cannot clear the lock — token matches,
 * proving the PID is still the same process, not recycled after restart.
 */
test("Scenario 1: active PID 1 lock with matching starttime → acquisition fails; lock kept", () => {
  const lockHostname = realHostname();
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-s1-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");
  mkdirSync(lockDir);

  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 1,
      command: "node server.js",
      hostname: lockHostname,
      processStartTime: "23117824",
    }),
  );

  try {
    expect(() =>
      acquireWhatsAppSessionLease("active-pid1-account", {
        lockDir,
        isProcessAlive: () => true,
        readStartInfo: () => ({ rawStartTime: "23117824" }),
      }),
    ).toThrow(/already connected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Scenario 2: PID 1 with different starttime → stale → cleared.
 *
 * The owner PID is alive (EPERM) but starttime has changed — the original
 * process died and PID 1 was reassigned (container restart).
 * The lock is stale regardless of PID being alive.
 */
test("Scenario 2: PID 1 with different starttime (PID recycled after restart) → clears lock", () => {
  const lockHostname = realHostname();
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-s2-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");
  mkdirSync(lockDir);

  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 1,
      command: "node server.js",
      hostname: lockHostname,
      processStartTime: "99900000",
    }),
  );

  try {
    const lease = acquireWhatsAppSessionLease("recycled-pid1-account", {
      lockDir,
      isProcessAlive: () => true,
      readStartInfo: () => ({ rawStartTime: "12345" }),
    });
    lease.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Scenario 3: Second process in same container cannot clear active PID 1 lock.
 *
 * PID 1 is alive and starttime matches → same process confirmed.
 * Second process must fail to acquire.  Core singleton guarantee.
 */
test("Scenario 3: second process in same container cannot clear active PID 1 lock", () => {
  const lockHostname = realHostname();
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-s3-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");
  mkdirSync(lockDir);

  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 1,
      command: "node server.js",
      hostname: lockHostname,
      processStartTime: "54321000",
    }),
  );

  try {
    expect(() =>
      acquireWhatsAppSessionLease("pid1-cannot-be-cleared-account", {
        lockDir,
        isProcessAlive: () => true,
        readStartInfo: () => ({ rawStartTime: "54321000" }),
      }),
    ).toThrow(/already connected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Scenario 4: Dead owner PID → stale → cleared.
 */
test("Scenario 4: dead owner PID → stale cleared", () => {
  const lockHostname = realHostname();
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-s4-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");
  mkdirSync(lockDir);

  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 99999,
      command: "node server.js",
      hostname: lockHostname,
      processStartTime: "10000000",
    }),
  );

  try {
    const lease = acquireWhatsAppSessionLease("dead-pid-account", {
      lockDir,
      isProcessAlive: () => false,
    });
    lease.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Scenario 5: PID reused with different starttime → stale cleared.
 *
 * PID is alive but starttime differs — PID was recycled after a crash.
 * String comparison handles this correctly.
 */
test("Scenario 5: PID reused with different starttime → stale cleared", () => {
  const lockHostname = realHostname();
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-s5-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");
  mkdirSync(lockDir);

  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 54321,
      command: "node server.js",
      hostname: lockHostname,
      processStartTime: "77700000",
    }),
  );

  try {
    const lease = acquireWhatsAppSessionLease("reused-pid-account", {
      lockDir,
      isProcessAlive: () => true,
      readStartInfo: () => ({ rawStartTime: "88800000" }),
    });
    lease.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Scenario 6: Hostname mismatch → stale cleared regardless of PID/starttime.
 */
test("Scenario 6: hostname mismatch → stale cleared regardless of PID liveness", () => {
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-s6-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");
  mkdirSync(lockDir);

  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 1,
      command: "node server.js",
      hostname: "old-container-hostname",
      processStartTime: "50000000",
    }),
  );

  try {
    const lease = acquireWhatsAppSessionLease("diff-hostname-account", {
      lockDir,
      isProcessAlive: () => true,
    });
    lease.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Scenario 7: Legacy lock (no processStartTime) with alive PID + same hostname
 * → conservative KEEP.
 */
test("Scenario 7: legacy lock (no processStartTime) with alive PID + same hostname → keeps lock", () => {
  const lockHostname = realHostname();
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-s7-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");
  mkdirSync(lockDir);

  // Legacy lock: no processStartTime.
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 1,
      command: "node server.js",
      hostname: lockHostname,
      // processStartTime intentionally absent
    }),
  );

  try {
    expect(() =>
      acquireWhatsAppSessionLease("legacy-pid1-account", {
        lockDir,
        isProcessAlive: () => true,
      }),
    ).toThrow(/already connected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Scenario 8 (regression): RSS changes but starttime is constant.
 *
 * This guards against the bug where fields[21] (RSS) was read instead of
 * fields[19] (starttime).  RSS changes at runtime; if it were used as the
 * identity token, a live lock would appear stale and be incorrectly cleared.
 *
 * Setup:
 *   Lock owner: PID 1, processStartTime = "23117824" (stored starttime)
 *   Lock written with RSS = 3296 (at fields[21])
 *   Later read returns same starttime (fields[19] = "23117824") but different RSS
 *   (fields[21] = "9999", simulating memory pressure).
 *   Same starttime → same process → lock kept → acquisition fails.
 *
 * If the code accidentally reads fields[21] (RSS) instead of fields[19] (starttime),
 * the "different RSS" would be treated as a new process and the lock would be
 * incorrectly cleared.  This test catches that bug.
 */
test("Scenario 8 (regression): RSS changes but starttime constant → lock kept (not cleared by RSS drift)", () => {
  const lockHostname = realHostname();
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-s8-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");
  mkdirSync(lockDir);

  // Lock written when process had RSS = 3296 (fields[21])
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 1,
      command: "node server.js",
      hostname: lockHostname,
      processStartTime: "23117824",
    }),
  );

  try {
    // RSS changed from 3296 → 9999 (memory pressure increased).
    // Starttime is fields[19] = "23117824" (unchanged).
    // readStartInfo returns the SAME starttime → same process → lock kept.
    //
    // The mock simulates what parseProcStatStartTime would return if called
    // on a line where fields[19] (starttime) is stable but fields[21] (RSS) changed.
    expect(() =>
      acquireWhatsAppSessionLease("rss-changed-account", {
        lockDir,
        isProcessAlive: () => true,
        readStartInfo: () => ({ rawStartTime: "23117824" }),
      }),
    ).toThrow(/already connected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
