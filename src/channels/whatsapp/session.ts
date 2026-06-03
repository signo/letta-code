import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { QrCodeTerminalModule } from "./runtime";
import { loadQrCodeTerminalModule, loadWhatsAppModule } from "./runtime";
import { setWhatsAppConnectionState } from "./state";

/**
 * WhatsApp session lock — process identity via starttime token.
 *
 * Lock owner identity is verified in three stages:
 *
 *  1. hostname — mismatch means different machine or container restarted.
 *
 *  2. owner.pid — absent or dead → stale.  Alive → verify with starttime.
 *
 *  3. owner.processStartTime — raw clock-tick token from /proc/<pid>/stat
 *     field 22 (1-based).  Compared as string equality:
 *       - match  → same process (live lock, acquisition fails)
 *       - differ → PID recycled after crash/restart (stale, lock cleared)
 *
 * Why starttime instead of a generated instanceId?
 * An instanceId written at lock acquisition time is different for every process,
 * so any second process would see a live lock as stale — violating the WhatsApp
 * singleton invariant.  Starttime is stable across a process lifetime and only
 * changes when the PID is genuinely recycled (crash, restart, container recreate).
 *
 * This implementation is Linux-specific.  readStartInfo returns null on
 * platforms without /proc; in that case the lock owner cannot be verified and
 * the conservative legacy path applies.
 *
 * Legacy locks (no processStartTime in owner.json):
 *   - PID alive + hostname matches → keep lock (conservative; cannot confirm
 *     continuity but the lock owner is still running).
 *   - PID dead → stale.
 *   - Hostname mismatch → stale.
 *
 * NOT USED:
 *   - CONTAINER_ID env var — not set in production.
 *   - PID 1 blanket rule — PID 1 is the normal server process inside a container;
 *     treated identically to any other PID based on start time.
 */

const SUPPRESSED_PATTERNS = [
  /^Session error:/,
  /^Closing open session in favor of incoming prekey bundle/,
  /^Closing session: SessionEntry/,
  /bad mac/i,
];

let filtersInstalled = false;
let suppressContinuation = false;

function shouldDropLine(line: unknown): boolean {
  if (typeof line !== "string") return false;
  if (SUPPRESSED_PATTERNS.some((pattern) => pattern.test(line))) {
    suppressContinuation = true;
    return true;
  }
  if (!suppressContinuation) return false;
  if (line.length === 0) {
    suppressContinuation = false;
    return true;
  }
  if (/^\s+at /.test(line)) return true;
  if (/^\s/.test(line) || line.startsWith("{") || line.startsWith("}"))
    return true;
  suppressContinuation = false;
  return false;
}

export function installWhatsAppConsoleFilters(): void {
  if (filtersInstalled) return;
  filtersInstalled = true;

  const originalError = globalThis.console.error;
  const originalWarn = globalThis.console.warn;
  globalThis.console.error = (...args) => {
    if (shouldDropLine(args[0])) return;
    originalError.apply(globalThis.console, args);
  };
  globalThis.console.warn = (...args) => {
    if (shouldDropLine(args[0])) return;
    originalWarn.apply(globalThis.console, args);
  };

  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    try {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      const lines = text.split("\n");
      const kept = lines.filter((line) => !shouldDropLine(line));
      if (kept.length === 0) return true;
      return originalStderrWrite(kept.join("\n"), ...(rest as []));
    } catch {
      return originalStderrWrite(chunk as never, ...(rest as []));
    }
  };
}

export function getWhatsAppAuthDir(accountId: string): string {
  return join(homedir(), ".letta", "channels", "whatsapp", "auth", accountId);
}

type WhatsAppSocket = {
  ev?: {
    on?: (event: string, handler: (payload?: unknown) => void) => void;
  };
  ws?: { close?: () => void };
  user?: { id?: string; lid?: string };
};

type WhatsAppRuntimeRecord = Record<string, unknown>;

type WhatsAppConnectionUpdate = Record<string, unknown> & {
  qr?: string;
  connection?: string;
  lastDisconnect?: {
    error?: {
      message?: string;
      output?: { statusCode?: number };
    };
  };
};

type WhatsAppAuthState = {
  creds: unknown;
  keys: unknown;
};

type CreateSocketResult = {
  sock: WhatsAppSocket;
  saveCreds: () => Promise<void>;
  DisconnectReason: Record<string, number>;
  release: () => void;
};

type WhatsAppSessionLease = {
  path: string;
  release: () => void;
};

const activeSessionLeases = new Map<string, string>();

function getWhatsAppSessionLockDir(accountId: string): string {
  return join(getWhatsAppAuthDir(accountId), ".session-lock");
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return code === "EPERM";
  }
}

// ── Process start time reader ────────────────────────────────────────────────

interface ProcessStartInfo {
  /**
   * Raw clock-tick token from /proc/<pid>/stat field 22 (1-based).
   * Stored and compared as a string to avoid any numeric ambiguity
   * (integer tokens are exact; floating-point comparison is not needed).
   */
  rawStartTime: string;
}

/**
 * Parse the starttime token from a /proc/<pid>/stat line.
 *
 * After slicing from the last ')' to skip the comm field, the fields are
 * (0-indexed; confirmed against /proc/1/stat on this system):
 *   fields[17] = 1-based field 18 = num_threads
 *   fields[18] = 1-based field 19 = itrealvalue (always 0 in modern kernels)
 *   fields[19] = 1-based field 22 = starttime (clock ticks since boot)  ← TARGET
 *   fields[20] = 1-based field 23 = vsize
 *   fields[21] = 1-based field 24 = RSS (changes as memory varies — NOT identity)
 *
 * NOTE: starttime for PID 1 can be small (tens/hundreds) since PID 1 starts
 * near boot. Do NOT assume starttime must be a large number — that is invalid
 * for PID 1. Use field position (fields[19]), not value magnitude, to identify
 * the starttime field.
 *
 * The prior bug: code read fields[20] (vsize) or fields[21] (RSS) — neither
 * is stable or correct as identity. Only fields[19] (starttime) is valid.
 *
 * Returns null if the starttime field is absent or whitespace.
 * Exported for direct unit-testing without needing a real PID.
 */
export function parseProcStatStartTime(statLine: string): string | null {
  const lastParen = statLine.lastIndexOf(")");
  if (lastParen === -1) return null;
  const fields = statLine
    .slice(lastParen + 2)
    .trim()
    .split(/\s+/);
  // fields[19] = starttime (1-based field 22).
  const token = fields[19];
  if (!token || token.trim() === "") return null;
  return token;
}

/**
 * Read the starttime token from /proc/<pid>/stat.
 *
 * Returns null if /proc is unavailable or the starttime field is absent.
 * This function is Linux-specific; callers must not assume /proc exists on
 * macOS or other platforms.
 *
 * Exposed via `readStartInfo` option so callers and tests can inject a mock.
 */
export function readStartInfo(pid: number): ProcessStartInfo | null {
  try {
    const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rawStartTime = parseProcStatStartTime(statLine);
    if (!rawStartTime) return null;
    return { rawStartTime };
  } catch {
    return null;
  }
}

/**
 * Verify whether the lock owner's process is still the same process.
 *
 * Returns true only when the PID is alive AND the current /proc/<pid>/stat
 * starttime token (field 22) matches owner.processStartTime exactly.
 * Token comparison is string-to-string — no division, no rounding, no tolerance.
 *
 * Returns false when:
 *  - owner.pid is absent or dead
 *  - start time read fails (/proc unavailable)
 *  - start time token differs (PID was recycled after crash/restart)
 *  - owner.processStartTime is absent (legacy lock — cannot verify; returns false
 *    so legacy path handles it based on PID liveness and hostname only)
 */
export function isOwnerProcessLiveAndSame(
  owner: {
    pid?: number;
    processStartTime?: string;
  },
  doReadStartInfo: (pid: number) => ProcessStartInfo | null,
): boolean {
  if (!owner.pid) return false;
  const startInfo = doReadStartInfo(owner.pid);
  if (!startInfo) return false;
  if (owner.processStartTime === undefined) return false;
  return startInfo.rawStartTime === owner.processStartTime;
}

function readLeaseOwner(lockDir: string): {
  pid?: number;
  command?: string;
  hostname?: string;
  containerId?: string;
  processStartTime?: string;
} {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockDir, "owner.json"), "utf8"),
    ) as {
      pid?: unknown;
      command?: unknown;
      hostname?: unknown;
      containerId?: unknown;
      processStartTime?: unknown;
    };
    return {
      pid: typeof owner.pid === "number" ? owner.pid : undefined,
      command: typeof owner.command === "string" ? owner.command : undefined,
      hostname: typeof owner.hostname === "string" ? owner.hostname : undefined,
      containerId:
        typeof owner.containerId === "string" ? owner.containerId : undefined,
      processStartTime:
        typeof owner.processStartTime === "string"
          ? owner.processStartTime
          : undefined,
    };
  } catch {
    return {};
  }
}

export function acquireWhatsAppSessionLease(
  accountId: string,
  options: {
    lockDir?: string;
    pid?: number;
    isProcessAlive?: (pid: number) => boolean;
    /** Override readStartInfo for tests. */
    readStartInfo?: (pid: number) => ProcessStartInfo | null;
  } = {},
): WhatsAppSessionLease {
  const lockDir = options.lockDir ?? getWhatsAppSessionLockDir(accountId);
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const doReadStartInfo: (pid: number) => ProcessStartInfo | null =
    "readStartInfo" in options && options.readStartInfo != null
      ? options.readStartInfo
      : readStartInfo;
  const activeLock = activeSessionLeases.get(accountId);
  if (activeLock) {
    throw new Error(
      `WhatsApp account ${accountId} already has an active session in this process (${activeLock}).`,
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir);
      // Capture our own start time token before writing.
      const ownStartInfo = doReadStartInfo(pid);
      const processStartTime =
        ownStartInfo !== null ? ownStartInfo.rawStartTime : undefined;
      writeFileSync(
        join(lockDir, "owner.json"),
        `${JSON.stringify(
          {
            accountId,
            pid,
            command: process.argv.join(" "),
            createdAt: new Date().toISOString(),
            hostname: hostname(),
            containerId: process.env.CONTAINER_ID ?? null,
            processStartTime,
          },
          null,
          2,
        )}\n`,
      );
      activeSessionLeases.set(accountId, lockDir);
      let released = false;
      return {
        path: lockDir,
        release() {
          if (released) return;
          released = true;
          if (activeSessionLeases.get(accountId) === lockDir) {
            activeSessionLeases.delete(accountId);
          }
          rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "EEXIST") {
        throw error;
      }
      const owner = readLeaseOwner(lockDir);

      // ── Stage 1: hostname check ─────────────────────────────────────────
      // Mismatch = different machine or container restart.
      const hostnameMatches = !owner.hostname || owner.hostname === hostname();
      if (!hostnameMatches) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      // ── Stage 2: PID liveness check ─────────────────────────────────────
      // Absent PID or dead PID = stale (no process to verify identity against).
      if (!owner.pid || !isProcessAlive(owner.pid)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      // ── Stage 3: process identity check via start time ─────────────────
      // sameProcess returns true only when:
      //   - PID is alive (checked above)
      //   - /proc/<pid>/stat start time matches owner.processStartTime exactly
      //   - (owner.processStartTime is absent → false, hits legacy path below)
      const sameProcess = isOwnerProcessLiveAndSame(owner, doReadStartInfo);

      if (!sameProcess) {
        // isOwnerProcessLiveAndSame returned false. Two possible causes:
        //
        // A) owner.processStartTime is present but start time differs
        //    → PID was recycled after crash/restart → stale → clear and retry.
        //
        // B) owner.processStartTime is absent (legacy lock predating this field)
        //    → be conservative: PID is alive and hostname matches → keep lock.
        //    The lock owner is still running; we cannot confirm continuity but
        //    there is no evidence of crash/restart either.
        if (owner.processStartTime !== undefined) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      }

      // PID alive + start time matches (or legacy with conservative keep) → lock is live.
      const ownerLabel = owner.pid
        ? `PID ${owner.pid}${owner.command ? ` (${owner.command})` : ""}`
        : "an unknown live process";
      throw new Error(
        `WhatsApp account ${accountId} is already connected by ${ownerLabel}. Stop that process before starting another WhatsApp server.`,
      );
    }
  }

  throw new Error(`Could not acquire WhatsApp session lock for ${accountId}.`);
}

function resolveMakeWASocket(
  mod: WhatsAppRuntimeRecord,
): (options: Record<string, unknown>) => WhatsAppSocket {
  const fn = mod.makeWASocket ?? mod.default;
  if (typeof fn !== "function") {
    throw new Error(
      'Installed WhatsApp runtime did not export "makeWASocket".',
    );
  }
  return fn as (options: Record<string, unknown>) => WhatsAppSocket;
}

function createSilentLogger() {
  const logger = {
    level: "silent",
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

export function renderQrTerminal(
  qrMod: QrCodeTerminalModule | null,
  input: string,
): string | undefined {
  const qrGenerator =
    typeof qrMod?.generate === "function"
      ? qrMod
      : typeof qrMod?.default?.generate === "function"
        ? qrMod.default
        : null;
  if (!qrGenerator) return undefined;
  const generate = qrGenerator.generate;
  if (typeof generate !== "function") return undefined;

  let qrTerminal: string | undefined;
  try {
    generate.call(qrGenerator, input, { small: true }, (output) => {
      qrTerminal = output;
    });
  } catch {
    return undefined;
  }
  return qrTerminal;
}

export async function createWhatsAppSocket(params: {
  accountId: string;
  printQr?: boolean;
  messageStore?: Map<string, unknown>;
  onConnectionUpdate?: (update: WhatsAppConnectionUpdate) => void;
}): Promise<CreateSocketResult> {
  installWhatsAppConsoleFilters();
  const authDir = getWhatsAppAuthDir(params.accountId);
  mkdirSync(authDir, { recursive: true });
  const sessionLease = acquireWhatsAppSessionLease(params.accountId);
  setWhatsAppConnectionState(params.accountId, { status: "connecting" });

  try {
    const mod = await loadWhatsAppModule();
    const runtime = mod as WhatsAppRuntimeRecord;
    const makeWASocket = resolveMakeWASocket(runtime);
    const useMultiFileAuthState = runtime.useMultiFileAuthState;
    if (typeof useMultiFileAuthState !== "function") {
      throw new Error(
        'Installed WhatsApp runtime did not export "useMultiFileAuthState".',
      );
    }
    const { state, saveCreds } = (await (
      useMultiFileAuthState as (
        path: string,
      ) => Promise<{ state: WhatsAppAuthState; saveCreds: () => Promise<void> }>
    )(authDir)) as { state: WhatsAppAuthState; saveCreds: () => Promise<void> };
    const fetchLatestBaileysVersion = runtime.fetchLatestBaileysVersion;
    const { version } =
      typeof fetchLatestBaileysVersion === "function"
        ? await (
            fetchLatestBaileysVersion as () => Promise<{ version?: unknown }>
          )().catch(() => ({ version: undefined }))
        : { version: undefined };
    const logger = createSilentLogger();
    const makeCacheableSignalKeyStore = runtime.makeCacheableSignalKeyStore;
    const auth =
      typeof makeCacheableSignalKeyStore === "function"
        ? {
            creds: state.creds,
            keys: (
              makeCacheableSignalKeyStore as (
                keys: unknown,
                logger: ReturnType<typeof createSilentLogger>,
              ) => unknown
            )(state.keys, logger),
          }
        : state;

    const sock = makeWASocket({
      auth,
      version,
      browser: ["Letta Code", "Desktop", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      logger,
      getMessage: async (key: { id?: string | null }) => {
        if (!key.id) return undefined;
        const stored = params.messageStore?.get(key.id) as
          | { message?: unknown }
          | undefined;
        return stored?.message;
      },
    });

    sock.ev?.on?.("creds.update", () => {
      void saveCreds().catch(() => undefined);
    });

    sock.ev?.on?.("connection.update", async (payload?: unknown) => {
      const update = (payload ?? {}) as WhatsAppConnectionUpdate;
      params.onConnectionUpdate?.(update);
      if (update.qr) {
        const qrMod = await loadQrCodeTerminalModule().catch(() => null);
        const qrTerminal = renderQrTerminal(qrMod, update.qr);
        setWhatsAppConnectionState(params.accountId, {
          status: "qr",
          qr: update.qr,
          qrTerminal,
        });
        if (params.printQr !== false) {
          console.log(
            `\n[WhatsApp:${params.accountId}] Pairing QR. Open WhatsApp → Settings → Linked Devices → Link a Device.\n`,
          );
          if (qrTerminal) {
            console.log(qrTerminal);
          } else {
            console.log(update.qr);
          }
        }
      }
      if (update.connection === "open") {
        setWhatsAppConnectionState(params.accountId, {
          status: "connected",
          phoneJid: sock.user?.id,
          lid: sock.user?.lid,
        });
      }
      if (update.connection === "close") {
        sessionLease.release();
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const disconnectReason = runtime.DisconnectReason as
          | Record<string, number>
          | undefined;
        const loggedOut = statusCode === disconnectReason?.loggedOut;
        setWhatsAppConnectionState(params.accountId, {
          status: loggedOut ? "logged_out" : "disconnected",
          lastError:
            update.lastDisconnect?.error?.message ??
            (statusCode
              ? `Connection closed (${statusCode})`
              : "Connection closed"),
        });
      }
    });

    return {
      sock,
      saveCreds,
      DisconnectReason: (runtime.DisconnectReason ?? {}) as Record<
        string,
        number
      >,
      release: sessionLease.release,
    };
  } catch (error) {
    sessionLease.release();
    throw error;
  }
}
