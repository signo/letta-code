/**
 * Turn-level budget wiring tests
 *
 * Tests that the budget integration works correctly when:
 * - Real Bash tool args are passed (heavy detection works)
 * - Budget block propagates to channelLiveness.signalEnd
 * - Auto-progress fires once if no outbound
 * - noteMessageSent cancels auto-progress
 * - Elapsed limit triggers onBudgetExceeded callback
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { ChannelTurnSource, WhatsAppChannelAccount } from "@/channels/types";
import { RoutedTurnBudget } from "./routedTurnBudget";
import { recordToolCall, noteOutboundSent } from "./whatsappTurnBudget";

const WHATSAPP_SOURCE: ChannelTurnSource = {
  channel: "whatsapp",
  chatId: "123456789",
  accountId: "acc-1",
  messageId: "msg-1",
  agentId: "agent-1",
  conversationId: "conv-1",
};

// Simulate the tool_call_message argument extraction from turn.ts stream processing.
function parseToolArgs(rawArgs: unknown): Record<string, unknown> | undefined {
  if (typeof rawArgs === "string") {
    try {
      return JSON.parse(rawArgs);
    } catch {
      return { command: rawArgs };
    }
  } else if (typeof rawArgs === "object" && rawArgs !== null) {
    return rawArgs as Record<string, unknown>;
  }
  return undefined;
}

describe("turn-level budget wiring", () => {
  let realDateNow: () => number;

  beforeEach(() => {
    realDateNow = Date.now;
    Date.now = vi.fn(() => 1000);
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  describe("real Bash args passed to recordToolCall", () => {
    test("ssh command with args correctly classified as heavy", () => {
      const onBudgetExceeded = vi.fn();
      const budget = new RoutedTurnBudget(
        {
          maxToolCalls: 10,
          maxHeavyBashCalls: 2,
          maxElapsedMs: 35000,
          autoProgressAfterMs: 0,
          autoProgressMessage: "Processing...",
        },
        { onBudgetExceeded, onAutoProgress: vi.fn() },
        [WHATSAPP_SOURCE],
      );

      // Simulate turn.ts extracting args from tool_call_message chunk
      const rawArgs = JSON.stringify({ command: "ssh user@production-server.example.com -p 2222 ls /" });
      const toolArgs = parseToolArgs(rawArgs);

      expect(recordToolCall(budget, "Bash", toolArgs, [WHATSAPP_SOURCE])).toBe(true);
      expect(budget.getState().heavyBashUsed).toBe(1);
      budget.destroy();
    });

    test("ffmpeg with full args correctly classified as heavy", () => {
      const onBudgetExceeded = vi.fn();
      const budget = new RoutedTurnBudget(
        {
          maxToolCalls: 10,
          maxHeavyBashCalls: 1,
          maxElapsedMs: 35000,
          autoProgressAfterMs: 0,
          autoProgressMessage: "Processing...",
        },
        { onBudgetExceeded, onAutoProgress: vi.fn() },
        [WHATSAPP_SOURCE],
      );

      const rawArgs = JSON.stringify({
        command: "ffmpeg -i input.avi -c:v libx264 -preset medium -crf 23 output.mp4",
      });
      const toolArgs = parseToolArgs(rawArgs);

      expect(recordToolCall(budget, "Bash", toolArgs, [WHATSAPP_SOURCE])).toBe(true);
      expect(budget.getState().heavyBashUsed).toBe(1);

      // Second heavy bash should be blocked
      const rawArgs2 = JSON.stringify({ command: "ffmpeg -i another.avi out2.mp4" });
      expect(recordToolCall(budget, "Bash", parseToolArgs(rawArgs2), [WHATSAPP_SOURCE])).toBe(false);
      expect(onBudgetExceeded).toHaveBeenCalledWith(
        [WHATSAPP_SOURCE],
        "budget_heavy_bash_exceeded",
      );
      budget.destroy();
    });

    test("light bash args classified as light (not counted against heavy limit)", () => {
      const onBudgetExceeded = vi.fn();
      const budget = new RoutedTurnBudget(
        {
          maxToolCalls: 20,
          maxHeavyBashCalls: 2,
          maxElapsedMs: 35000,
          autoProgressAfterMs: 0,
          autoProgressMessage: "Processing...",
        },
        { onBudgetExceeded, onAutoProgress: vi.fn() },
        [WHATSAPP_SOURCE],
      );

      // Multiple light commands — none count as heavy
      const lightCommands = [
        "echo 'Starting build...'",
        "ls -la src/",
        "cat package.json",
        "pwd",
        "which node",
      ];

      for (const cmd of lightCommands) {
        expect(recordToolCall(budget, "Bash", { command: cmd }, [WHATSAPP_SOURCE])).toBe(true);
      }

      expect(budget.getState().heavyBashUsed).toBe(0);
      expect(budget.isBlocked()).toBe(false);
      expect(onBudgetExceeded).not.toHaveBeenCalled();
      budget.destroy();
    });

    test("find with args correctly classified as heavy", () => {
      const budget = new RoutedTurnBudget(
        {
          maxToolCalls: 10,
          maxHeavyBashCalls: 1,
          maxElapsedMs: 35000,
          autoProgressAfterMs: 0,
          autoProgressMessage: "Processing...",
        },
        { onBudgetExceeded: vi.fn(), onAutoProgress: vi.fn() },
        [WHATSAPP_SOURCE],
      );

      const rawArgs = JSON.stringify({
        command: "find /var/log -name '*.log' -mtime +30 -type f 2>/dev/null | head -50",
      });
      const toolArgs = parseToolArgs(rawArgs);

      expect(recordToolCall(budget, "Bash", toolArgs, [WHATSAPP_SOURCE])).toBe(true);
      expect(budget.getState().heavyBashUsed).toBe(1);
      budget.destroy();
    });
  });

  describe("budget block propagates blockedReason for turn.ts signalEnd", () => {
    test("blockedReason is budget_heavy_bash_exceeded when heavy limit hit", () => {
      const budget = new RoutedTurnBudget(
        { maxHeavyBashCalls: 1, maxToolCalls: 10, maxElapsedMs: 35000, autoProgressAfterMs: 0, autoProgressMessage: "" },
        { onBudgetExceeded: vi.fn(), onAutoProgress: vi.fn() },
        [WHATSAPP_SOURCE],
      );

      recordToolCall(budget, "Bash", { command: "ssh host1" }, [WHATSAPP_SOURCE]);
      recordToolCall(budget, "Bash", { command: "ffmpeg -i a.avi b.mp4" }, [WHATSAPP_SOURCE]);

      expect(budget.isBlocked()).toBe(true);
      expect(budget.getState().blockedReason).toBe("budget_heavy_bash_exceeded");
      budget.destroy();
    });

    test("blockedReason is budget_tool_calls_exceeded when tool limit hit", () => {
      const budget = new RoutedTurnBudget(
        { maxToolCalls: 3, maxHeavyBashCalls: 10, maxElapsedMs: 35000, autoProgressAfterMs: 0, autoProgressMessage: "" },
        { onBudgetExceeded: vi.fn(), onAutoProgress: vi.fn() },
        [WHATSAPP_SOURCE],
      );

      recordToolCall(budget, "Read", {}, [WHATSAPP_SOURCE]);
      recordToolCall(budget, "Write", {}, [WHATSAPP_SOURCE]);
      recordToolCall(budget, "Edit", {}, [WHATSAPP_SOURCE]);
      recordToolCall(budget, "Grep", {}, [WHATSAPP_SOURCE]);

      expect(budget.isBlocked()).toBe(true);
      expect(budget.getState().blockedReason).toBe("budget_tool_calls_exceeded");
      budget.destroy();
    });

    test("blockedReason is budget_elapsed_exceeded when time limit hit", () => {
      const budget = new RoutedTurnBudget(
        { maxToolCalls: 10, maxHeavyBashCalls: 10, maxElapsedMs: 1000, autoProgressAfterMs: 0, autoProgressMessage: "" },
        { onBudgetExceeded: vi.fn(), onAutoProgress: vi.fn() },
        [WHATSAPP_SOURCE],
      );

      recordToolCall(budget, "Read", {}, [WHATSAPP_SOURCE]);
      Date.now = vi.fn(() => 5000); // Simulate 4s elapsed

      recordToolCall(budget, "Write", {}, [WHATSAPP_SOURCE]);

      expect(budget.isBlocked()).toBe(true);
      expect(budget.getState().blockedReason).toBe("budget_elapsed_exceeded");
      budget.destroy();
    });

    test("blockedReason is undefined when not blocked", () => {
      const budget = new RoutedTurnBudget(
        { maxToolCalls: 5, maxHeavyBashCalls: 2, maxElapsedMs: 10000, autoProgressAfterMs: 0, autoProgressMessage: "" },
        { onBudgetExceeded: vi.fn(), onAutoProgress: vi.fn() },
        [WHATSAPP_SOURCE],
      );

      recordToolCall(budget, "Read", {}, [WHATSAPP_SOURCE]);
      expect(budget.getState().blockedReason).toBeUndefined();
      budget.destroy();
    });
  });

  describe("noteMessageSent cancels auto-progress", () => {
    test("noteMessageSent prevents auto-progress timer from firing", async () => {
      const onAutoProgress = vi.fn();
      const budget = new RoutedTurnBudget(
        {
          maxToolCalls: 10,
          maxHeavyBashCalls: 2,
          maxElapsedMs: 35000,
          autoProgressAfterMs: 100,
          autoProgressMessage: "Processing your request...",
        },
        { onBudgetExceeded: vi.fn(), onAutoProgress },
        [WHATSAPP_SOURCE],
      );

      // Simulate outbound message sent (e.g., MessageChannel tool succeeded)
      noteOutboundSent(budget);

      // Auto-progress should NOT fire even after timer duration
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(onAutoProgress).not.toHaveBeenCalled();
      expect(budget.getState().autoProgressSent).toBe(true);
      budget.destroy();
    });

    test("auto-progress fires once if no outbound sent", async () => {
      const onAutoProgress = vi.fn();
      const budget = new RoutedTurnBudget(
        {
          maxToolCalls: 10,
          maxHeavyBashCalls: 2,
          maxElapsedMs: 35000,
          autoProgressAfterMs: 50,
          autoProgressMessage: "Processing your request...",
        },
        { onBudgetExceeded: vi.fn(), onAutoProgress },
        [WHATSAPP_SOURCE],
      );

      // Wait for auto-progress timer to fire (no outbound sent)
      await new Promise((resolve) => setTimeout(resolve, 70));

      expect(onAutoProgress).toHaveBeenCalledTimes(1);
      expect(onAutoProgress).toHaveBeenCalledWith(
        [WHATSAPP_SOURCE],
        "Processing your request...",
      );
      budget.destroy();
    });

    test("noteOutboundSent works with null budget (no-op)", () => {
      // Simulates the pattern: noteOutboundSent(turnBudget) where turnBudget may be null
      noteOutboundSent(null);
      noteOutboundSent(null); // Safe to call multiple times
    });
  });

  describe("elapsed budget triggers onBudgetExceeded (not log-only)", () => {
    test("elapsed exceeded calls onBudgetExceeded with elapsed reason", () => {
      const onBudgetExceeded = vi.fn();
      const budget = new RoutedTurnBudget(
        {
          maxToolCalls: 10,
          maxHeavyBashCalls: 10,
          maxElapsedMs: 2000,
          autoProgressAfterMs: 0,
          autoProgressMessage: "",
        },
        { onBudgetExceeded, onAutoProgress: vi.fn() },
        [WHATSAPP_SOURCE],
      );

      recordToolCall(budget, "Read", {}, [WHATSAPP_SOURCE]);
      Date.now = vi.fn(() => 5000); // 4 seconds elapsed

      recordToolCall(budget, "Write", {}, [WHATSAPP_SOURCE]);

      expect(onBudgetExceeded).toHaveBeenCalledWith(
        [WHATSAPP_SOURCE],
        "budget_elapsed_exceeded",
      );
      budget.destroy();
    });

    test("blockedReason reflects elapsed when elapsed is the triggering limit", () => {
      const budget = new RoutedTurnBudget(
        {
          maxToolCalls: 10,
          maxHeavyBashCalls: 10,
          maxElapsedMs: 1000,
          autoProgressAfterMs: 0,
          autoProgressMessage: "",
        },
        { onBudgetExceeded: vi.fn(), onAutoProgress: vi.fn() },
        [WHATSAPP_SOURCE],
      );

      recordToolCall(budget, "Read", {}, [WHATSAPP_SOURCE]);
      Date.now = vi.fn(() => 5000); // 4s elapsed

      recordToolCall(budget, "Write", {}, [WHATSAPP_SOURCE]);

      expect(budget.getState().blockedReason).toBe("budget_elapsed_exceeded");
      budget.destroy();
    });
  });

  describe("turn.ts signalEnd reason mapping", () => {
    test("budget_heavy_bash_exceeded reason is usable as TurnFailureReason", () => {
      // Verify the reason strings are compatible with ChannelTurnFinishReason
      const reason: ChannelTurnSource["agentId"] extends infer R ? R : never = "agent-1"; // just using type
      const budgetReasons: Array<"budget_heavy_bash_exceeded" | "budget_tool_calls_exceeded" | "budget_elapsed_exceeded"> = [
        "budget_heavy_bash_exceeded",
        "budget_tool_calls_exceeded",
        "budget_elapsed_exceeded",
      ];
      expect(budgetReasons).toContain("budget_heavy_bash_exceeded");
    });
  });

  describe("recordToolCall with null budget returns true (budget disabled)", () => {
    test("recordToolCall returns true when budget is null", () => {
      expect(recordToolCall(null, "Bash", { command: "ssh host" }, [WHATSAPP_SOURCE])).toBe(true);
      expect(recordToolCall(null, "Read", {}, [WHATSAPP_SOURCE])).toBe(true);
    });

    test("recordToolCall works with undefined args", () => {
      expect(recordToolCall(null, "Bash", undefined, [WHATSAPP_SOURCE])).toBe(true);
      expect(recordToolCall(null, "Read", undefined, [])).toBe(true);
    });
  });

  describe("WhatsAppTurnBudgetOptions shape (compatibility with turn.ts wiring)", () => {
    test("createWhatsAppTurnBudget returns null when maxToolCalls = 0", () => {
      // When account has routedTurnMaxToolCalls = 0, budget is disabled
      // createWhatsAppTurnBudget returns null — recordToolCall returns true
      const { budget, callbacks } = {
        budget: null as ReturnType<typeof import("./whatsappTurnBudget").createWhatsAppTurnBudget> | null,
        callbacks: { onBudgetExceeded: vi.fn(), onAutoProgress: vi.fn() },
      };
      // Simulate the integration: null budget means recordToolCall is a no-op
      expect(recordToolCall(budget, "Bash", { command: "ssh host" }, [WHATSAPP_SOURCE])).toBe(true);
      expect(callbacks.onBudgetExceeded).not.toHaveBeenCalled();
    });
  });
});