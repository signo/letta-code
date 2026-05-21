export const WHATSAPP_CHANNEL_ID = "whatsapp";
export const WHATSAPP_PHONE_SUFFIX = "@s.whatsapp.net";
export const WHATSAPP_LID_SUFFIX = "@lid";
export const WHATSAPP_GROUP_SUFFIX = "@g.us";

export function stripDeviceSuffix(jid: string | null | undefined): string {
  if (!jid) return "";
  return jid.replace(/:\d+(@|$)/, "$1");
}

export function isPhoneJid(jid: string | null | undefined): boolean {
  return !!jid && stripDeviceSuffix(jid).endsWith(WHATSAPP_PHONE_SUFFIX);
}

export function isLidJid(jid: string | null | undefined): boolean {
  return !!jid && stripDeviceSuffix(jid).endsWith(WHATSAPP_LID_SUFFIX);
}

export function isGroupJid(jid: string | null | undefined): boolean {
  return !!jid && stripDeviceSuffix(jid).endsWith(WHATSAPP_GROUP_SUFFIX);
}

export function isStatusOrBroadcastJid(
  jid: string | null | undefined,
): boolean {
  if (!jid) return true;
  const normalized = stripDeviceSuffix(jid);
  return (
    normalized === "status@broadcast" ||
    normalized.endsWith("@broadcast") ||
    normalized.endsWith("@newsletter")
  );
}

export function jidToDigits(jid: string | null | undefined): string {
  if (!jid) return "";
  const base = stripDeviceSuffix(jid).split("@")[0] ?? "";
  return base.replace(/\D/g, "");
}

export function normalizePhoneLike(value: string | null | undefined): string {
  if (!value) return "";
  return jidToDigits(value.trim());
}

export function phoneDigitsToJid(phoneDigits: string): string {
  const digits = normalizePhoneLike(phoneDigits);
  return digits ? `${digits}${WHATSAPP_PHONE_SUFFIX}` : "";
}

export function normalizeMaybePhoneJid(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isLidJid(trimmed)) return null;
  if (trimmed.includes("@")) return stripDeviceSuffix(trimmed);
  return phoneDigitsToJid(trimmed) || null;
}

export function isSelfChat(
  remoteJid: string | null | undefined,
  selfPhoneJid: string | null | undefined,
  selfLid: string | null | undefined,
): boolean {
  const remote = stripDeviceSuffix(remoteJid);
  if (!remote) return false;
  const phone = stripDeviceSuffix(selfPhoneJid);
  if (phone && remote === phone) return true;
  const lid = stripDeviceSuffix(selfLid);
  if (lid && remote === lid) return true;
  return false;
}

export function senderIdFromJid(jid: string | null | undefined): string {
  return jidToDigits(jid);
}

export function allowedUsersIncludes(
  allowedUsers: string[],
  senderId: string,
): boolean {
  const normalizedSender = normalizePhoneLike(senderId);
  return allowedUsers.some(
    (entry) => normalizePhoneLike(entry) === normalizedSender,
  );
}

export function resolveLidToPhoneJid(params: {
  lidJid: string;
  message?: unknown;
  sock?: unknown;
}): string | null {
  const { lidJid, message, sock } = params;
  if (!isLidJid(lidJid)) return normalizeMaybePhoneJid(lidJid);

  const msg = message as { key?: { senderPn?: string | null } } | undefined;
  const senderPn = normalizeMaybePhoneJid(msg?.key?.senderPn ?? undefined);
  if (senderPn) return senderPn;

  const repo = (
    sock as
      | {
          signalRepository?: {
            lidMapping?:
              | Map<string, string>
              | Record<string, string>
              | { get?: (key: string) => string | undefined };
          };
        }
      | undefined
  )?.signalRepository;
  const lidKey = stripDeviceSuffix(lidJid);
  const rawLidMapping = repo?.lidMapping;
  const mappedValue =
    rawLidMapping instanceof Map
      ? rawLidMapping.get(lidKey)
      : typeof rawLidMapping === "object" && rawLidMapping
        ? typeof (rawLidMapping as { get?: unknown }).get === "function"
          ? (rawLidMapping as { get: (key: string) => string | undefined }).get(
              lidKey,
            )
          : (rawLidMapping as Record<string, string>)[lidKey]
        : undefined;
  const mapped = normalizeMaybePhoneJid(mappedValue);
  if (mapped) return mapped;

  return null;
}

export function resolveSendJid(params: {
  chatId: string;
  selfPhoneJid?: string | null;
  selfLid?: string | null;
  lidToJid?: Map<string, string>;
  sock?: unknown;
}): string {
  const { chatId, selfPhoneJid, selfLid, lidToJid, sock } = params;
  if (!isLidJid(chatId)) return stripDeviceSuffix(chatId);

  const normalized = stripDeviceSuffix(chatId);
  if (selfLid && normalized === stripDeviceSuffix(selfLid) && selfPhoneJid) {
    return stripDeviceSuffix(selfPhoneJid);
  }

  const mapped = normalizeMaybePhoneJid(lidToJid?.get(normalized));
  if (mapped) return mapped;

  const repo = (
    sock as
      | {
          signalRepository?: {
            lidMapping?:
              | Map<string, string>
              | Record<string, string>
              | { get?: (key: string) => string | undefined };
          };
        }
      | undefined
  )?.signalRepository;
  const rawLidMapping = repo?.lidMapping;
  const signalMappedValue =
    rawLidMapping instanceof Map
      ? rawLidMapping.get(normalized)
      : typeof rawLidMapping === "object" && rawLidMapping
        ? typeof (rawLidMapping as { get?: unknown }).get === "function"
          ? (rawLidMapping as { get: (key: string) => string | undefined }).get(
              normalized,
            )
          : (rawLidMapping as Record<string, string>)[normalized]
        : undefined;
  const signalMapped = normalizeMaybePhoneJid(signalMappedValue);
  if (signalMapped) return signalMapped;

  // No phone JID mapping found — fall back to the normalized LID.
  // Baileys accepts LID JIDs as send targets; if the message arrived on
  // this LID, WhatsApp's servers already confirmed it is routable.
  return normalized;
}

export function sanitizePathSegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "whatsapp";
}
