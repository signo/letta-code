import type { WhatsAppGroupMode } from "@/channels/types";

const MAX_MENTION_PATTERN_LENGTH = 256;
const MENTION_MATCH_TEXT_MAX_LENGTH = 2000;

export interface GroupEligibilityInput {
  groupMode: WhatsAppGroupMode;
  allowedGroups?: string[];
  mentionPatterns?: string[];
  groupJid: string;
  text: string;
  mentionedJids: string[];
  replyParticipant: string | null;
  selfPhoneJid: string | null;
  selfLid: string | null;
}

export type GroupEligibilityResult =
  | { eligible: true }
  | {
      eligible: false;
      reason: "group_disabled" | "group_not_allowed" | "no_mention_signal";
    };

export function checkGroupEligibility(
  input: GroupEligibilityInput,
): GroupEligibilityResult {
  const {
    groupMode,
    allowedGroups,
    mentionPatterns,
    groupJid,
    text,
    mentionedJids,
    replyParticipant,
    selfPhoneJid,
    selfLid,
  } = input;

  if (groupMode === "disabled") {
    return { eligible: false, reason: "group_disabled" };
  }

  if (
    allowedGroups &&
    allowedGroups.length > 0 &&
    !allowedGroups.includes(groupJid)
  ) {
    return { eligible: false, reason: "group_not_allowed" };
  }

  if (groupMode === "open") {
    return { eligible: true };
  }

  if (mentionedJids.some((jid) => matchesSelf(jid, selfPhoneJid, selfLid))) {
    return { eligible: true };
  }

  if (
    replyParticipant &&
    matchesSelf(replyParticipant, selfPhoneJid, selfLid)
  ) {
    return { eligible: true };
  }

  const matchText = text.slice(0, MENTION_MATCH_TEXT_MAX_LENGTH);
  for (const pattern of mentionPatterns ?? []) {
    if (pattern.length > MAX_MENTION_PATTERN_LENGTH) continue;
    try {
      if (new RegExp(pattern, "i").test(matchText)) {
        return { eligible: true };
      }
    } catch {
      // Ignore invalid user-provided regex patterns.
    }
  }

  return { eligible: false, reason: "no_mention_signal" };
}

function stripDeviceSuffix(jid: string): string {
  return jid.replace(/:\d+(@|$)/, "$1");
}

function matchesSelf(
  jid: string,
  selfPhoneJid: string | null,
  selfLid: string | null,
): boolean {
  const normalized = stripDeviceSuffix(jid);
  return (
    (!!selfPhoneJid && normalized === stripDeviceSuffix(selfPhoneJid)) ||
    (!!selfLid && normalized === stripDeviceSuffix(selfLid))
  );
}
