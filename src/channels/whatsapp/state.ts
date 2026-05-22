import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChannelDir } from "@/channels/config";

export type WhatsAppConnectionStatus =
  | "idle"
  | "qr"
  | "connecting"
  | "connected"
  | "disconnected"
  | "logged_out"
  | "error";

export interface WhatsAppMessageDiagnostic {
  chatId: string;
  messageId?: string;
  timestamp: number;
}

export interface WhatsAppConnectionState {
  status: WhatsAppConnectionStatus;
  qr?: string;
  qrTerminal?: string;
  phoneJid?: string;
  lid?: string;
  lastError?: string;
  lastErrorAt?: string;
  lastInbound?: WhatsAppMessageDiagnostic;
  lastOutbound?: WhatsAppMessageDiagnostic;
  updatedAt: string;
}

type Listener = (accountId: string, state: WhatsAppConnectionState) => void;

const states = new Map<string, WhatsAppConnectionState>();
const listeners = new Set<Listener>();

let diagnosticsDirOverride: string | null = null;

function diagnosticsDir(): string {
  if (diagnosticsDirOverride) return diagnosticsDirOverride;
  return join(getChannelDir("whatsapp"), "diagnostics");
}

function diagnosticsPath(accountId: string): string {
  const safe = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(diagnosticsDir(), `${safe}.json`);
}

function loadPersistedState(
  accountId: string,
): Partial<WhatsAppConnectionState> {
  try {
    const path = diagnosticsPath(accountId);
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<WhatsAppConnectionState>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistState(accountId: string, state: WhatsAppConnectionState): void {
  try {
    mkdirSync(diagnosticsDir(), { recursive: true });
    writeFileSync(
      diagnosticsPath(accountId),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf-8",
    );
  } catch {
    // best effort persistence
  }
}

export function getWhatsAppConnectionState(
  accountId: string,
): WhatsAppConnectionState {
  const existing = states.get(accountId);
  if (existing) return existing;

  const persisted = loadPersistedState(accountId);
  return {
    status: "idle",
    updatedAt: new Date(0).toISOString(),
    ...persisted,
  };
}

export function setWhatsAppConnectionState(
  accountId: string,
  patch: Omit<Partial<WhatsAppConnectionState>, "updatedAt">,
): WhatsAppConnectionState {
  const existing = getWhatsAppConnectionState(accountId);
  const next: WhatsAppConnectionState = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (patch.status && patch.status !== "qr") {
    delete next.qr;
    delete next.qrTerminal;
  }
  states.set(accountId, next);
  persistState(accountId, next);
  for (const listener of listeners) {
    listener(accountId, next);
  }
  return next;
}

export function clearWhatsAppConnectionState(accountId: string): void {
  states.delete(accountId);
  try {
    rmSync(diagnosticsPath(accountId), { force: true });
  } catch {
    // best effort cleanup
  }
}

export function subscribeWhatsAppConnectionState(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toWhatsAppConnectionConfig(
  accountId: string,
): Record<string, unknown> {
  const state = getWhatsAppConnectionState(accountId);
  return {
    connection_status: state.status,
    has_qr: Boolean(state.qr),
    ...(state.qr ? { qr: state.qr } : {}),
    ...(state.qrTerminal ? { qr_terminal: state.qrTerminal } : {}),
    ...(state.phoneJid ? { phone_jid: state.phoneJid } : {}),
    ...(state.lid ? { lid: state.lid } : {}),
    ...(state.lastError ? { last_error: state.lastError } : {}),
    ...(state.lastErrorAt ? { last_error_at: state.lastErrorAt } : {}),
    ...(state.lastInbound
      ? {
          last_inbound: {
            chat_id: state.lastInbound.chatId,
            ...(state.lastInbound.messageId
              ? { message_id: state.lastInbound.messageId }
              : {}),
            timestamp: state.lastInbound.timestamp,
          },
        }
      : {}),
    ...(state.lastOutbound
      ? {
          last_outbound: {
            chat_id: state.lastOutbound.chatId,
            ...(state.lastOutbound.messageId
              ? { message_id: state.lastOutbound.messageId }
              : {}),
            timestamp: state.lastOutbound.timestamp,
          },
        }
      : {}),
    connection_updated_at: state.updatedAt,
  };
}

export function __testSetWhatsAppDiagnosticsDir(dir: string | null): void {
  diagnosticsDirOverride = dir;
}
