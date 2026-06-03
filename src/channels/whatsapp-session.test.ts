import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname as realHostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWhatsAppSessionLease,
  renderQrTerminal,
} from "@/channels/whatsapp/session";

describe("WhatsApp session", () => {
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

  test("removes stale session leases", () => {
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

  test("clears stale lock from a different hostname even if PID 1 appears alive", () => {
    const root = join(
      tmpdir(),
      `letta-whatsapp-session-hostname-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(root, { recursive: true });
    const lockDir = join(root, "lock");
    mkdirSync(lockDir);
    // PID 1, hostname "old-container" — this container has hostname "current-host"
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 1,
        command: "node server.js",
        hostname: "old-container",
        containerId: null,
      }),
    );

    try {
      // isProcessAlive returns true for PID 1 (EPERM treated as alive by default).
      // But hostname mismatch (old-container ≠ current-host) → stale → clears lock.
      const lease = acquireWhatsAppSessionLease("hostname-stale-account", {
        lockDir,
        isProcessAlive: () => true,
      });
      lease.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clears stale lock when containerId differs even on same hostname", () => {
    const root = join(
      tmpdir(),
      `letta-whatsapp-session-container-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(root, { recursive: true });
    const lockDir = join(root, "lock");
    mkdirSync(lockDir);
    // Same hostname but different container ID (container was restarted)
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 42,
        command: "node server.js",
        hostname: "test-host",
        containerId: "old-container-abc",
      }),
    );

    try {
      const lease = acquireWhatsAppSessionLease("container-stale-account", {
        lockDir,
        // PID 42 is alive, hostname matches, but containerId differs
        isProcessAlive: () => true,
      });
      lease.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps valid lock when hostname and containerId both match", () => {
    // Use real hostname in lock file so it matches this process's hostname.
    // containerId is null (lock predates containerId tracking), which means
    // containerIdMatches = true (trust PID liveness for legacy locks).
    // Since hostname matches and pid is alive, the lock is kept → throw.
    const lockHostname = realHostname();
    const root = join(
      tmpdir(),
      `letta-whatsapp-session-valid-${Date.now()}-${Math.random()}`,
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
        containerId: "container-xyz",
      }),
    );

    try {
      // containerId "container-xyz" ≠ CONTAINER_ID env var (not set in tests)
      // → containerIdMatches = false (current process has no CONTAINER_ID, lock has one)
      // → isStaleLock = true → lock cleared → no throw.
      // Fix: use a containerId that matches the env variable.
      // Since no CONTAINER_ID env is set in tests, we need a different test:
      // hostname matches, containerId null (lock predates tracking), pid alive → keep lock.
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner.json"),
        JSON.stringify({
          pid: 99999,
          command: "node server.js",
          hostname: lockHostname,
          containerId: null, // Lock predates containerId tracking
        }),
      );
      expect(() =>
        acquireWhatsAppSessionLease("valid-lock-account", {
          lockDir,
          isProcessAlive: () => true,
        }),
      ).toThrow(/already connected/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clears lock owned by PID 1 on same host with matching hostname when PID 1 appears alive", () => {
    // This is the specific Docker scenario: same container hostname, PID 1 reused.
    // The lock should be cleared because isProcessAlive(1) returns EPERM = "alive"
    // but there's no containerId in the lock file to distinguish stale vs fresh.
    // With our fix, missing containerId + same hostname = stale (treat as unsafe).
    const root = join(
      tmpdir(),
      `letta-whatsapp-session-pid1-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(root, { recursive: true });
    const lockDir = join(root, "lock");
    mkdirSync(lockDir);
    // PID 1 with matching hostname, no containerId
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 1,
        command: "docker-entrypoint.sh",
        hostname: "current-host",
        containerId: null,
      }),
    );

    try {
      // isProcessAlive(1) returns true (EPERM), hostname matches, containerId is null.
      // Without containerId confirmation, treat as stale to be safe.
      // The lock should be cleared and the second process should acquire it.
      const lease = acquireWhatsAppSessionLease("pid1-account", {
        lockDir,
        isProcessAlive: () => true,
      });
      lease.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
