import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { ChannelTurnSource } from "@/channels/types";
import { isHeavyBashCommand } from "./heavyBashClassifier";
import { RoutedTurnBudget } from "./routedTurnBudget";

const WHATSAPP_SOURCE: ChannelTurnSource = {
  channel: "whatsapp",
  chatId: "123456789",
  accountId: "acc-1",
  messageId: "msg-1",
  agentId: "agent-1",
  conversationId: "conv-1",
};

function createBudget(overrides = {}) {
  const callbacks = {
    onBudgetExceeded: vi.fn(),
    onAutoProgress: vi.fn(),
  };
  const budget = new RoutedTurnBudget(
    {
      maxToolCalls: 8,
      maxHeavyBashCalls: 2,
      maxElapsedMs: 10000,
      autoProgressAfterMs: 100,
      autoProgressMessage: "Processing...",
      ...overrides,
    },
    callbacks,
    [WHATSAPP_SOURCE],
  );
  return { budget, callbacks };
}

describe("RoutedTurnBudget", () => {
  let realDateNow: () => number;

  beforeEach(() => {
    realDateNow = Date.now;
    Date.now = vi.fn(() => 1000);
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  describe("heavy bash limit", () => {
    test("blocks SSH when heavy bash limit exceeded", () => {
      const { budget, callbacks } = createBudget({ maxHeavyBashCalls: 2 });
      expect(budget.recordToolCall("Bash", { command: "ssh s1" }, [WHATSAPP_SOURCE])).toBe(true);
      expect(budget.getState().heavyBashUsed).toBe(1);
      expect(budget.recordToolCall("Bash", { command: "ssh s2" }, [WHATSAPP_SOURCE])).toBe(true);
      expect(budget.getState().heavyBashUsed).toBe(2);
      expect(budget.recordToolCall("Bash", { command: "ssh s3" }, [WHATSAPP_SOURCE])).toBe(false);
      expect(callbacks.onBudgetExceeded).toHaveBeenCalledWith([WHATSAPP_SOURCE], "budget_heavy_bash_exceeded");
      budget.destroy();
    });

    test("blocks ffmpeg when heavy bash limit exceeded", () => {
      const { budget, callbacks } = createBudget({ maxHeavyBashCalls: 1 });
      budget.recordToolCall("Bash", { command: "ffmpeg -i a.avi b.mp4" }, [WHATSAPP_SOURCE]);
      expect(budget.getState().heavyBashUsed).toBe(1);
      expect(budget.recordToolCall("Bash", { command: "ffmpeg -i c.avi d.mp4" }, [WHATSAPP_SOURCE])).toBe(false);
      expect(callbacks.onBudgetExceeded).toHaveBeenCalledWith([WHATSAPP_SOURCE], "budget_heavy_bash_exceeded");
      budget.destroy();
    });

    test("light bash commands don't count against heavy limit", () => {
      const { budget } = createBudget({ maxHeavyBashCalls: 2, maxToolCalls: 20 });
      budget.recordToolCall("Bash", { command: "echo hello" }, [WHATSAPP_SOURCE]);
      budget.recordToolCall("Bash", { command: "ls -la" }, [WHATSAPP_SOURCE]);
      budget.recordToolCall("Bash", { command: "cat file.txt" }, [WHATSAPP_SOURCE]);
      budget.recordToolCall("Bash", { command: "pwd" }, [WHATSAPP_SOURCE]);
      expect(budget.getState().heavyBashUsed).toBe(0);
      expect(budget.isBlocked()).toBe(false);
      budget.destroy();
    });

    test("find, nohup, curl with pipes classified as heavy", () => {
      expect(isHeavyBashCommand("find . -name '*.log' -mtime +7")).toBe(true);
      expect(isHeavyBashCommand("nohup ./script.sh &")).toBe(true);
      expect(isHeavyBashCommand("curl -s http://x.com | jq")).toBe(true);
      expect(isHeavyBashCommand("top")).toBe(true);
      expect(isHeavyBashCommand("sleep 300 &")).toBe(true);
    });
  });

  describe("tool-call limit", () => {
    test("blocks after maxToolCalls exceeded", () => {
      const { budget, callbacks } = createBudget({ maxToolCalls: 3 });
      budget.recordToolCall("Read", {}, [WHATSAPP_SOURCE]);
      expect(budget.getState().toolCallsUsed).toBe(1);
      budget.recordToolCall("Write", {}, [WHATSAPP_SOURCE]);
      expect(budget.getState().toolCallsUsed).toBe(2);
      budget.recordToolCall("Edit", {}, [WHATSAPP_SOURCE]);
      expect(budget.getState().toolCallsUsed).toBe(3);
      expect(budget.recordToolCall("Grep", {}, [WHATSAPP_SOURCE])).toBe(false);
      expect(callbacks.onBudgetExceeded).toHaveBeenCalledWith([WHATSAPP_SOURCE], "budget_tool_calls_exceeded");
      budget.destroy();
    });

    test("blockedReason reflects tool_calls_exceeded", () => {
      const { budget } = createBudget({ maxToolCalls: 2 });
      budget.recordToolCall("Read", {}, [WHATSAPP_SOURCE]);
      budget.recordToolCall("Write", {}, [WHATSAPP_SOURCE]);
      budget.recordToolCall("Edit", {}, [WHATSAPP_SOURCE]);
      expect(budget.getState().blockedReason).toBe("budget_tool_calls_exceeded");
      budget.destroy();
    });
  });

  describe("elapsed limit", () => {
    test("blocks after elapsed time exceeded", () => {
      const { budget, callbacks } = createBudget({ maxElapsedMs: 2000 });
      budget.recordToolCall("Read", {}, [WHATSAPP_SOURCE]);
      Date.now = vi.fn(() => 5000);
      expect(budget.recordToolCall("Write", {}, [WHATSAPP_SOURCE])).toBe(false);
      expect(callbacks.onBudgetExceeded).toHaveBeenCalledWith([WHATSAPP_SOURCE], "budget_elapsed_exceeded");
      budget.destroy();
    });

    test("blockedReason reflects elapsed_exceeded", () => {
      const { budget } = createBudget({ maxElapsedMs: 1000 });
      budget.recordToolCall("Read", {}, [WHATSAPP_SOURCE]);
      Date.now = vi.fn(() => 3000);
      budget.recordToolCall("Write", {}, [WHATSAPP_SOURCE]);
      expect(budget.getState().blockedReason).toBe("budget_elapsed_exceeded");
      budget.destroy();
    });
  });

  describe("reason priority", () => {
    test("heavy bash takes priority when both limits hit", () => {
      const { budget, callbacks } = createBudget({ maxToolCalls: 10, maxHeavyBashCalls: 1 });
      budget.recordToolCall("Bash", { command: "ssh host" }, [WHATSAPP_SOURCE]);
      budget.recordToolCall("Bash", { command: "ffmpeg -i a.avi b.mp4" }, [WHATSAPP_SOURCE]);
      expect(callbacks.onBudgetExceeded).toHaveBeenCalledWith([WHATSAPP_SOURCE], "budget_heavy_bash_exceeded");
      budget.destroy();
    });
  });

  describe("auto-progress", () => {
    test("onAutoProgress receives sources", async () => {
      const { callbacks } = createBudget({ autoProgressAfterMs: 50 });
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(callbacks.onAutoProgress).toHaveBeenCalledWith([WHATSAPP_SOURCE], "Processing...");
    });

    test("blockedReason is undefined when not blocked", () => {
      const { budget } = createBudget();
      expect(budget.getState().blockedReason).toBeUndefined();
      budget.destroy();
    });
  });

  describe("noteMessageSent", () => {
    test("cancels auto-progress timer", () => {
      const { budget } = createBudget({ autoProgressAfterMs: 10000 });
      budget.noteMessageSent();
      expect(budget.getState().autoProgressSent).toBe(true);
      budget.destroy();
    });
  });

  describe("blockedReason correctness", () => {
    test("returns heavy when heavy limit hit", () => {
      const { budget } = createBudget({ maxHeavyBashCalls: 1 });
      budget.recordToolCall("Bash", { command: "ssh host" }, [WHATSAPP_SOURCE]);
      budget.recordToolCall("Bash", { command: "ffmpeg -i a.avi b.mp4" }, [WHATSAPP_SOURCE]);
      expect(budget.getState().blockedReason).toBe("budget_heavy_bash_exceeded");
      budget.destroy();
    });

    test("returns tool_calls when tool limit hit", () => {
      const { budget } = createBudget({ maxToolCalls: 2 });
      budget.recordToolCall("Read", {}, [WHATSAPP_SOURCE]);
      budget.recordToolCall("Write", {}, [WHATSAPP_SOURCE]);
      budget.recordToolCall("Edit", {}, [WHATSAPP_SOURCE]);
      expect(budget.getState().blockedReason).toBe("budget_tool_calls_exceeded");
      budget.destroy();
    });

    test("returns elapsed when time limit hit", () => {
      const { budget } = createBudget({ maxElapsedMs: 1000 });
      budget.recordToolCall("Read", {}, [WHATSAPP_SOURCE]);
      Date.now = vi.fn(() => 5000);
      budget.recordToolCall("Write", {}, [WHATSAPP_SOURCE]);
      expect(budget.getState().blockedReason).toBe("budget_elapsed_exceeded");
      budget.destroy();
    });
  });

  describe("destroy", () => {
    test("clears auto-progress timer", () => {
      const { budget } = createBudget({ autoProgressAfterMs: 10000 });
      budget.destroy();
      expect(budget.getState().autoProgressSent).toBe(false);
    });
  });
});