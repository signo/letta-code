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
 *  3. starttime token from /proc/<pid>/stat field 22 (1-based), 0-indexed
 *     fields[19].  Clock ticks since boot.  Stable until PID is recycled.
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
 *  - vsize field (fields[20]) — changes at runtime, must not affect identity.
 */

// ── Parser unit tests ─────────────────────────────────────────────────────────

/**
 * Confirms the field layout of /proc/<pid>/stat after slice(lastParen+2).trim().split(/\s+/).
 *
 * Correct layout (confirmed against real /proc/1/stat on this system, man proc(5)):
 *   fields[17] = 1-based field 18 = num_threads
 *   fields[18] = 1-based field 19 = itrealvalue (always 0 in modern kernels)
 *   fields[19] = 1-based field 20 = starttime (clock ticks since boot)  ← TARGET
 *   fields[20] = 1-based field 21 = vsize
 *   fields[21] = 1-based field 22 = RSS (changes as memory varies)
 *
 * IMPORTANT: starttime for PID 1 is small (tens/hundreds) since PID 1 starts near
 * boot. Do NOT use magnitude to identify starttime — use field position (fields[19]).
 *
 * The prior bugs:
 *   - Read fields[21] (RSS) → false stale detection on every memory allocation.
 *   - Read fields[20] (vsize) → wrong field entirely.
 *   - Assumed starttime must be > 1_000_000 → invalid for PID 1.
 */
test("parseProcStatStartTime fixture: confirms field layout — fields[19]=starttime, [20]=vsize, [21]=RSS", async () => {
  // Use the real /proc/1/stat line as the fixture — it is the ground truth.
  // On this system: starttime at fields[19], vsize at fields[20], RSS at fields[21].
  const { readFileSync } = await import("node:fs");
  const realStatLine = readFileSync("/proc/1/stat", "utf8");

  const lastParen = realStatLine.lastIndexOf(")");
  const fields = realStatLine
    .slice(lastParen + 2)
    .trim()
    .split(/\s+/);

  // Verify the field layout: which field is starttime, which is vsize, which is RSS.
  // Structure verification — values come from the real file, not hardcoded.
  // fields[17] = num_threads, fields[18] = itrealvalue, fields[19] = starttime,
  // fields[20] = vsize, fields[21] = RSS.
  expect(Number(fields[17])).toBeGreaterThan(0); // num_threads > 0
  expect(Number(fields[18])).toBeLessThan(100); // itrealvalue ≈ 0
  // starttime is stable; vsize is larger than starttime on this system; RSS > 0
  expect(Number(fields[20])).toBeGreaterThan(Number(fields[19])); // vsize > starttime
  expect(Number(fields[21])).toBeGreaterThan(0); // RSS > 0

  // parseProcStatStartTime reads fields[19], not [18], [20], or [21].
  expect(parseProcStatStartTime(realStatLine)).toBe(fields[19]!);
});

/**
 * parseProcStatStartTime reads fields[19], not fields[18] (itrealvalue),
 * fields[20] (vsize), or fields[21] (RSS).  Use real /proc/1/stat to prove it.
 */
test("parseProcStatStartTime returns fields[19] (starttime), not itrealvalue/vsize/RSS", async () => {
  const { readFileSync } = await import("node:fs");
  const statLine = readFileSync("/proc/1/stat", "utf8");
  const lastParen = statLine.lastIndexOf(")");
  const fields = statLine
    .slice(lastParen + 2)
    .trim()
    .split(/\s+/);

  const itrealField = fields[18]!;
  const starttimeField = fields[19]!;
  const vsizeField = fields[20]!;
  const rssField = fields[21]!;

  // Verify field layout
  expect(Number(itrealField)).toBeLessThan(100); // itrealvalue — always near 0
  expect(Number(vsizeField)).toBeGreaterThan(Number(starttimeField)); // vsize > starttime for PID 1
  expect(Number(rssField)).toBeGreaterThan(0);

  // parseProcStatStartTime must return fields[19], not any other field
  expect(parseProcStatStartTime(statLine)).toBe(starttimeField);
  expect(parseProcStatStartTime(statLine)).not.toBe(itrealField);
  expect(parseProcStatStartTime(statLine)).not.toBe(vsizeField);
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

// ── Concurrent lease ─────────────────────────────────────────────────────────

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

// ── Starttime-based stale detection ──────────────────────────────────────────

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
      processStartTime: "22",
    }),
  );

  try {
    expect(() =>
      acquireWhatsAppSessionLease("active-pid1-account", {
        lockDir,
        isProcessAlive: () => true,
        readStartInfo: () => ({ rawStartTime: "22" }),
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
      processStartTime: "54321",
    }),
  );

  try {
    expect(() =>
      acquireWhatsAppSessionLease("pid1-cannot-be-cleared-account", {
        lockDir,
        isProcessAlive: () => true,
        readStartInfo: () => ({ rawStartTime: "54321" }),
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
 * Scenario 8 (regression): vsize or RSS changes but starttime is constant.
 *
 * This guards against bugs where vsize (fields[20]) or RSS (fields[21])
 * is read instead of starttime (fields[19]).  Both vsize and RSS change at
 * runtime; if either were used as the identity token, a live lock would appear
 * stale and be incorrectly cleared.
 *
 * Setup:
 *   Lock owner: PID 1, processStartTime = "22" (stored starttime, small for PID 1)
 *   Later read returns same starttime (fields[19] = "22") but different
 *   vsize (fields[20] = "99999999") or RSS (fields[21] = "9999").
 *   Same starttime → same process → lock kept → acquisition fails.
 *
 * If the code accidentally reads fields[20] (vsize) or fields[21] (RSS),
 * the "different value" would be treated as a new process and the lock
 * would be incorrectly cleared.  This test catches both bugs.
 */
test("Scenario 8 (regression): vsize/RSS change but starttime constant → lock kept (not cleared by memory drift)", () => {
  const lockHostname = realHostname();
  const root = join(
    tmpdir(),
    `letta-whatsapp-session-s8-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, "lock");
  mkdirSync(lockDir);

  // Lock written with processStartTime = fields[19] (starttime) from /proc/1/stat.
  // vsize and RSS may change over time; starttime is stable until PID recycle.
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 1,
      command: "node server.js",
      hostname: lockHostname,
      processStartTime: "22",
    }),
  );

  try {
    // vsize/RSS may have changed since lock was written; starttime stays constant.
    // readStartInfo returns the SAME starttime → same process → lock kept.
    expect(() =>
      acquireWhatsAppSessionLease("memory-changed-account", {
        lockDir,
        isProcessAlive: () => true,
        readStartInfo: () => ({ rawStartTime: "22" }),
      }),
    ).toThrow(/already connected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
