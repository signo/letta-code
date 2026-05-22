import { describe, expect, test } from "bun:test";
import type { GroupEligibilityInput } from "@/channels/whatsapp/groupPolicy";
import {
  checkGroupEligibility,
  GROUP_DROP_HINTS,
} from "@/channels/whatsapp/groupPolicy";

const SELF_PHONE = "15551112222@s.whatsapp.net";
const SELF_LID = "210565536456917@lid";
const GROUP_A = "1234567890@g.us";
const GROUP_B = "9876543210@g.us";

const baseInput: GroupEligibilityInput = {
  groupMode: "open",
  allowedGroups: undefined,
  mentionPatterns: undefined,
  groupJid: GROUP_A,
  text: "hello world",
  mentionedJids: [],
  replyParticipant: null,
  selfPhoneJid: SELF_PHONE,
  selfLid: SELF_LID,
};

describe("checkGroupEligibility", () => {
  test("disabled always blocks", () => {
    const result = checkGroupEligibility({
      ...baseInput,
      groupMode: "disabled",
    });
    expect(result).toEqual({ eligible: false, reason: "group_disabled" });
  });

  test("open allows when no allowlist", () => {
    const result = checkGroupEligibility({ ...baseInput, groupMode: "open" });
    expect(result).toEqual({ eligible: true });
  });

  test("allowed_groups gate precedence", () => {
    const result = checkGroupEligibility({
      ...baseInput,
      groupMode: "mention",
      groupJid: GROUP_B,
      allowedGroups: [GROUP_A],
      mentionedJids: [SELF_PHONE],
    });
    expect(result).toEqual({ eligible: false, reason: "group_not_allowed" });
  });

  test("mention mode requires mention signal", () => {
    const result = checkGroupEligibility({
      ...baseInput,
      groupMode: "mention",
      mentionedJids: [],
      replyParticipant: null,
      mentionPatterns: undefined,
    });
    expect(result).toEqual({ eligible: false, reason: "no_mention_signal" });
  });

  test("mention mode allows self mention", () => {
    const result = checkGroupEligibility({
      ...baseInput,
      groupMode: "mention",
      mentionedJids: [SELF_PHONE],
    });
    expect(result).toEqual({ eligible: true });
  });

  test("mention mode allows mention pattern", () => {
    const result = checkGroupEligibility({
      ...baseInput,
      groupMode: "mention",
      text: "hey bot, help",
      mentionPatterns: ["\\bhey\\s+bot\\b"],
    });
    expect(result).toEqual({ eligible: true });
  });

  test("device suffix normalization works", () => {
    const result = checkGroupEligibility({
      ...baseInput,
      groupMode: "mention",
      mentionedJids: ["15551112222:5@s.whatsapp.net"],
      selfPhoneJid: SELF_PHONE,
      selfLid: null,
    });
    expect(result).toEqual({ eligible: true });
  });

  test("mention mode allows reply-to-self signal", () => {
    const result = checkGroupEligibility({
      ...baseInput,
      groupMode: "mention",
      replyParticipant: SELF_LID,
    });
    expect(result).toEqual({ eligible: true });
  });

  test("drop hints map contains all reasons", () => {
    expect(GROUP_DROP_HINTS.group_disabled).toBeTruthy();
    expect(GROUP_DROP_HINTS.group_not_allowed).toBeTruthy();
    expect(GROUP_DROP_HINTS.no_mention_signal).toBeTruthy();
  });
});
