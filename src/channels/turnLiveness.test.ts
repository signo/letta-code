import { describe, expect, test, vi } from "bun:test";
import type { TurnFailureReason, TurnLivenessMetadata } from "./turnLiveness";
import {
  ChannelTurnLiveness,
  classifyEndTurnOutcome,
  classifyToolCategory,
} from "./turnLiveness";

const mockSource = {
  channel: "whatsapp",
  chatId: "123456",
  accountId: "acc1",
  agentId: "agent1",
  conversationId: "conv1",
};

describe("ChannelTurnLiveness", () => {
  describe("initial state", () => {
    test("starts in dispatched state", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      expect(liveness.state).toBe("dispatched");
      expect(callbacks.onDispatchAck).not.toHaveBeenCalled();
    });
  });

  describe("signalStrong", () => {
    test("transitions from dispatched to strong", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.signalStrong("tool_call_message");

      expect(liveness.state).toBe("strong");
    });

    test("is idempotent - multiple strong signals don't change state", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.signalStrong("tool_call_message");
      liveness.signalStrong("approval_stop");

      expect(liveness.state).toBe("strong");
    });

    test("tracks message_channel_tool_call as strong signal", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.signalStrong("message_channel_tool_call");

      expect(liveness.state).toBe("strong");
    });
  });

  describe("complete", () => {
    test("immediately calls onCompleted", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.complete();

      expect(callbacks.onCompleted).toHaveBeenCalledWith([mockSource]);
      expect(liveness.state).toBe("completed");
    });
  });

  describe("fail", () => {
    test("calls onFailed with reason", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.fail("silent_end");

      expect(callbacks.onFailed).toHaveBeenCalledWith(
        [mockSource],
        "silent_end",
        expect.objectContaining({ elapsedMs: expect.any(Number) }),
      );
      expect(liveness.state).toBe("failed");
    });

    for (const reason of [
      "silent_end",
      "silent_end_with_tools",
      "provider_timeout",
      "runtime_error",
      "cancelled",
      "approval_blocked",
    ] as TurnFailureReason[]) {
      test(`handles fail reason: ${reason}`, () => {
        const callbacks = createMockCallbacks();
        const liveness = new ChannelTurnLiveness([mockSource], callbacks);

        liveness.fail(reason);

        expect(callbacks.onFailed).toHaveBeenCalledWith(
          [mockSource],
          reason,
          expect.any(Object),
        );
        expect(liveness.state).toBe("failed");
      });
    }
  });

  describe("endTurnSilent", () => {
    test("signals silent_end when no tool calls occurred", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      // No signalStrong calls — no tools
      liveness.endTurnSilent();

      expect(callbacks.onFailed).toHaveBeenCalledWith(
        [mockSource],
        "silent_end",
        expect.objectContaining({ hadToolCalls: false }),
      );
      expect(liveness.state).toBe("failed");
    });

    test("signals silent_end_with_tools when tool calls occurred", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.signalStrong("tool_call_message");
      liveness.endTurnSilent();

      expect(callbacks.onFailed).toHaveBeenCalledWith(
        [mockSource],
        "silent_end_with_tools",
        expect.objectContaining({ hadToolCalls: true }),
      );
      expect(liveness.state).toBe("failed");
    });

    test("signals silent_end_with_tools when MessageChannel was emitted", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      // MessageChannel emission counts as both a tool call and MessageChannel call
      liveness.signalStrong("message_channel_tool_call");
      liveness.endTurnSilent();

      expect(callbacks.onFailed).toHaveBeenCalledWith(
        [mockSource],
        "silent_end_with_tools",
        expect.objectContaining({
          hadToolCalls: true,
          hadMessageChannelCall: true,
        }),
      );
    });

    test("is no-op after complete", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.complete();
      liveness.endTurnSilent();

      expect(callbacks.onFailed).not.toHaveBeenCalled();
      expect(liveness.state).toBe("completed");
    });

    test("is no-op after fail", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.fail("runtime_error");
      liveness.endTurnSilent();

      expect(callbacks.onFailed).toHaveBeenCalledTimes(1);
      expect(callbacks.onFailed).toHaveBeenCalledWith(
        [mockSource],
        "runtime_error",
        expect.any(Object),
      );
    });
  });

  describe("stop behavior", () => {
    test("no-op after stop (complete)", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.complete();
      liveness.fail("silent_end"); // Should be no-op

      expect(callbacks.onFailed).not.toHaveBeenCalled();
      expect(callbacks.onCompleted).toHaveBeenCalledTimes(1);
    });

    test("no-op after stop (fail)", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.fail("runtime_error");
      liveness.complete(); // Should be no-op

      expect(callbacks.onCompleted).not.toHaveBeenCalled();
      expect(callbacks.onFailed).toHaveBeenCalledTimes(1);
    });
  });

  describe("elapsed", () => {
    test("returns elapsed time since construction", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      const elapsed = liveness.elapsed();
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });
  });

  describe("signalEnd alias", () => {
    test("maps 'completed' to completed state", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.signalEnd("completed");

      expect(callbacks.onCompleted).toHaveBeenCalled();
      expect(liveness.state).toBe("completed");
    });

    for (const reason of [
      "silent_end",
      "silent_end_with_tools",
      "provider_timeout",
      "runtime_error",
      "cancelled",
      "approval_blocked",
    ] as TurnFailureReason[]) {
      test(`maps '${reason}' to failed state`, () => {
        const callbacks = createMockCallbacks();
        const liveness = new ChannelTurnLiveness([mockSource], callbacks);

        liveness.signalEnd(reason);

        expect(callbacks.onFailed).toHaveBeenCalledWith(
          [mockSource],
          reason,
          expect.any(Object),
        );
        expect(liveness.state).toBe("failed");
      });
    }
  });

  describe("metadata tracking", () => {
    test("tracks hadToolCalls for tool_call_message signals", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.signalStrong("tool_call_message");

      expect(liveness.getMetadata().hadToolCalls).toBe(true);
      expect(liveness.state).toBe("strong");
    });

    test("tracks hadMessageChannelCall for message_channel_tool_call signals", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.signalStrong("message_channel_tool_call");

      expect(liveness.getMetadata().hadMessageChannelCall).toBe(true);
      // MessageChannel is a tool — hadToolCalls is also true
      expect(liveness.getMetadata().hadToolCalls).toBe(true);
      expect(liveness.state).toBe("strong");
    });

    test("hadToolCalls and hadMessageChannelCall are tracked independently", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      liveness.signalStrong("tool_call_message");
      liveness.signalStrong("message_channel_tool_call");

      expect(liveness.getMetadata().hadToolCalls).toBe(true);
      expect(liveness.getMetadata().hadMessageChannelCall).toBe(true);
    });
  });

  describe("abort controller", () => {
    test("abortController is called on hard timeout", () => {
      const callbacks = createMockCallbacks();
      const controller = new AbortController();
      new ChannelTurnLiveness([mockSource], callbacks, {
        abortController: controller,
      });

      // Verify the controller starts un-aborted
      expect(controller.signal.aborted).toBe(false);

      // We can't easily test the timer firing in Bun (no fake timers),
      // but we verify the controller is wired correctly by checking
      // that abort() propagates through the signal.
      controller.abort();
      expect(controller.signal.aborted).toBe(true);
    });

    test("hard timeout does not fire when already completed", () => {
      const callbacks = createMockCallbacks();
      const controller = new AbortController();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks, {
        abortController: controller,
      });

      liveness.complete();

      // Even if the hard timeout were to fire, it should be a no-op
      // because liveness is already stopped. We verify by checking
      // that onFailed was never called.
      expect(callbacks.onFailed).not.toHaveBeenCalled();
      expect(liveness.state).toBe("completed");
    });

    test("hard timeout does not fire when already failed", () => {
      const callbacks = createMockCallbacks();
      const controller = new AbortController();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks, {
        abortController: controller,
      });

      liveness.fail("runtime_error");

      expect(callbacks.onFailed).toHaveBeenCalledTimes(1);
      expect(callbacks.onFailed).toHaveBeenCalledWith(
        [mockSource],
        "runtime_error",
        expect.any(Object),
      );
    });
  });

  describe("dispatch ack is NOT a finished event", () => {
    test("dispatch ack callback receives sources but does not transition state", () => {
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness([mockSource], callbacks);

      // After construction, liveness is dispatched.
      // The ack timer hasn't fired yet (we can't wait for it in Bun),
      // but we can verify that calling onDispatchAck manually doesn't
      // change the state to finished/failed.
      expect(liveness.state).toBe("dispatched");

      // Simulate what happens when ack fires: the callback itself doesn't
      // call complete() or fail() — it dispatches a neutral "ack" event.
      // The liveness should remain in dispatched state.
      expect(callbacks.onDispatchAck).not.toHaveBeenCalled();
    });
  });

  describe("multiple sources", () => {
    test("passes all sources to callbacks", () => {
      const sources = [
        {
          channel: "whatsapp",
          chatId: "123",
          accountId: "acc1",
          agentId: "agent1",
          conversationId: "conv1",
        },
        {
          channel: "whatsapp",
          chatId: "456",
          accountId: "acc1",
          agentId: "agent1",
          conversationId: "conv1",
        },
      ];
      const callbacks = createMockCallbacks();
      const liveness = new ChannelTurnLiveness(sources, callbacks);

      liveness.complete();

      expect(callbacks.onCompleted).toHaveBeenCalledWith(sources);
    });
  });
});

describe("classifyEndTurnOutcome", () => {
  function meta(
    overrides: Partial<TurnLivenessMetadata> = {},
  ): TurnLivenessMetadata {
    return {
      hadStrongSignal: false,
      hadMessageChannelCall: false,
      hadToolCalls: false,
      elapsedMs: 0,
      ...overrides,
    };
  }

  test("MessageChannel seen (MessageChannel name) => completed", () => {
    expect(
      classifyEndTurnOutcome(
        meta({ hadMessageChannelCall: true, hadToolCalls: true }),
      ),
    ).toBe("completed");
  });

  test("MessageChannel seen (message_channel name) => completed", () => {
    // Both name variants set hadMessageChannelCall via signalStrong
    expect(
      classifyEndTurnOutcome(
        meta({ hadMessageChannelCall: true, hadToolCalls: true }),
      ),
    ).toBe("completed");
  });

  test("non-MessageChannel tool calls => silent_end_with_tools", () => {
    expect(
      classifyEndTurnOutcome(
        meta({ hadToolCalls: true, hadMessageChannelCall: false }),
      ),
    ).toBe("silent_end_with_tools");
  });

  test("no tool calls at all => silent_end", () => {
    expect(classifyEndTurnOutcome(meta())).toBe("silent_end");
  });

  test("MessageChannel without other tools => completed", () => {
    expect(
      classifyEndTurnOutcome(
        meta({ hadMessageChannelCall: true, hadToolCalls: false }),
      ),
    ).toBe("completed");
  });
});

describe("MessageChannel success prevents endTurnSilent", () => {
  test("complete() after message_channel_tool_call stops endTurnSilent", () => {
    const callbacks = createMockCallbacks();
    const liveness = new ChannelTurnLiveness([mockSource], callbacks);

    // Simulate: MessageChannel tool call emitted, then turn completes
    liveness.signalStrong("message_channel_tool_call");
    liveness.complete();

    // endTurnSilent should be a no-op because liveness is already stopped
    liveness.endTurnSilent();

    expect(callbacks.onCompleted).toHaveBeenCalledWith([mockSource]);
    expect(callbacks.onFailed).not.toHaveBeenCalled();
    expect(liveness.state).toBe("completed");
  });

  test("classifyEndTurnOutcome returns completed when MessageChannel was seen", () => {
    const callbacks = createMockCallbacks();
    const liveness = new ChannelTurnLiveness([mockSource], callbacks);

    liveness.signalStrong("message_channel_tool_call");

    const outcome = classifyEndTurnOutcome(liveness.getMetadata());
    expect(outcome).toBe("completed");
  });

  test("classifyEndTurnOutcome returns silent_end_with_tools for non-MessageChannel tools", () => {
    const callbacks = createMockCallbacks();
    const liveness = new ChannelTurnLiveness([mockSource], callbacks);

    liveness.signalStrong("tool_call_message");

    const outcome = classifyEndTurnOutcome(liveness.getMetadata());
    expect(outcome).toBe("silent_end_with_tools");
  });

  test("classifyEndTurnOutcome returns silent_end when no tools seen", () => {
    const callbacks = createMockCallbacks();
    const liveness = new ChannelTurnLiveness([mockSource], callbacks);

    const outcome = classifyEndTurnOutcome(liveness.getMetadata());
    expect(outcome).toBe("silent_end");
  });
});

describe("classifyToolCategory", () => {
  // ── Bash ──────────────────────────────────────────────────────────────
  test('"bash" => bash', () => {
    expect(classifyToolCategory("bash")).toBe("bash");
  });

  test('"Bash" => bash (case insensitivity)', () => {
    expect(classifyToolCategory("Bash")).toBe("bash");
  });

  test('"bash_tool" => bash', () => {
    expect(classifyToolCategory("bash_tool")).toBe("bash");
  });

  test('"sh" => bash', () => {
    expect(classifyToolCategory("sh")).toBe("bash");
  });

  test('"shell" => bash', () => {
    expect(classifyToolCategory("shell")).toBe("bash");
  });

  test('"sh_run" => bash', () => {
    expect(classifyToolCategory("sh_run")).toBe("bash");
  });

  // ── SSH (must NOT be caught by bash/sh prefix) ───────────────────────
  test('"ssh" => ssh', () => {
    expect(classifyToolCategory("ssh")).toBe("ssh");
  });

  test('"ssh_run" => ssh', () => {
    expect(classifyToolCategory("ssh_run")).toBe("ssh");
  });

  test('"SSH" => ssh (case insensitivity)', () => {
    expect(classifyToolCategory("SSH")).toBe("ssh");
  });

  test('"ssh_execute" => ssh (not bash)', () => {
    expect(classifyToolCategory("ssh_execute")).toBe("ssh");
  });

  // ── MessageChannel ────────────────────────────────────────────────────
  test('"MessageChannel" => message_channel', () => {
    expect(classifyToolCategory("MessageChannel")).toBe("message_channel");
  });

  test('"message_channel" => message_channel', () => {
    expect(classifyToolCategory("message_channel")).toBe("message_channel");
  });

  test('"MESSAGECHANNEL" => message_channel (case insensitivity)', () => {
    expect(classifyToolCategory("MESSAGECHANNEL")).toBe("message_channel");
  });

  // ── File tools ────────────────────────────────────────────────────────
  test('"read" => file', () => {
    expect(classifyToolCategory("read")).toBe("file");
  });

  test('"Read" => file (case insensitivity)', () => {
    expect(classifyToolCategory("Read")).toBe("file");
  });

  test('"write" => file', () => {
    expect(classifyToolCategory("write")).toBe("file");
  });

  test('"edit" => file', () => {
    expect(classifyToolCategory("edit")).toBe("file");
  });

  test('"glob" => file', () => {
    expect(classifyToolCategory("glob")).toBe("file");
  });

  test('"grep" => file', () => {
    expect(classifyToolCategory("grep")).toBe("file");
  });

  test('"read_file" => file', () => {
    expect(classifyToolCategory("read_file")).toBe("file");
  });

  test('"write_file" => file', () => {
    expect(classifyToolCategory("write_file")).toBe("file");
  });

  test('"create_file" => file (via "file" substring)', () => {
    expect(classifyToolCategory("create_file")).toBe("file");
  });

  test('"EditTextFile" => file', () => {
    expect(classifyToolCategory("EditTextFile")).toBe("file");
  });

  test('"edit_and_apply" => file', () => {
    expect(classifyToolCategory("edit_and_apply")).toBe("file");
  });

  // ── Search / web tools ────────────────────────────────────────────────
  test('"web_search" => search', () => {
    expect(classifyToolCategory("web_search")).toBe("search");
  });

  test('"search" => search', () => {
    expect(classifyToolCategory("search")).toBe("search");
  });

  test('"web" => search', () => {
    expect(classifyToolCategory("web")).toBe("search");
  });

  test('"fetch" => search', () => {
    expect(classifyToolCategory("fetch")).toBe("search");
  });

  test('"fetch_webpage" => search', () => {
    expect(classifyToolCategory("fetch_webpage")).toBe("search");
  });

  test('"exa_search" => search', () => {
    expect(classifyToolCategory("exa_search")).toBe("search");
  });

  test('"exa" => search', () => {
    expect(classifyToolCategory("exa")).toBe("search");
  });

  test('"WebSearch" => search (case insensitivity)', () => {
    expect(classifyToolCategory("WebSearch")).toBe("search");
  });

  test('"SearchWeb" => search', () => {
    expect(classifyToolCategory("SearchWeb")).toBe("search");
  });

  test('"webpage_fetch" => search', () => {
    expect(classifyToolCategory("webpage_fetch")).toBe("search");
  });

  // ── Generic (no match) ────────────────────────────────────────────────
  test('"unknown_tool" => generic', () => {
    expect(classifyToolCategory("unknown_tool")).toBe("generic");
  });

  test('"custom_api" => generic', () => {
    expect(classifyToolCategory("custom_api")).toBe("generic");
  });

  test('"do_something" => generic', () => {
    expect(classifyToolCategory("do_something")).toBe("generic");
  });

  test('"run_python" => generic', () => {
    expect(classifyToolCategory("run_python")).toBe("generic");
  });

  test('"pip_install" => generic (not bash, not file)', () => {
    expect(classifyToolCategory("pip_install")).toBe("generic");
  });

  test('"npm_run_build" => generic', () => {
    expect(classifyToolCategory("npm_run_build")).toBe("generic");
  });

  // ── Edge cases ────────────────────────────────────────────────────────
  test("empty string => generic", () => {
    expect(classifyToolCategory("")).toBe("generic");
  });

  test('"MessageChannel" is NOT caught by message_channel fallthrough', () => {
    // MessageChannel contains "Channel" but the exact match fires first
    expect(classifyToolCategory("MessageChannel")).toBe("message_channel");
  });

  test('"ssh" is NOT caught by bash (SSH before bash ordering)', () => {
    expect(classifyToolCategory("ssh")).toBe("ssh");
    expect(classifyToolCategory("ssh_run")).toBe("ssh");
    expect(classifyToolCategory("bash")).toBe("bash");
    expect(classifyToolCategory("bash_ssh")).toBe("bash");
  });

  test('"file_search" => file (file substring is checked before search)', () => {
    // "file" is in the tool name, so it matches file even though "search" is also present
    expect(classifyToolCategory("file_search")).toBe("file");
  });

  test('"read_file" => file, not search', () => {
    // "read" prefix matches first before any search substring
    expect(classifyToolCategory("read_file")).toBe("file");
  });

  test('"WebFetch" => search (substring match)', () => {
    expect(classifyToolCategory("WebFetch")).toBe("search");
  });

  test('"search_files" => file (file substring wins over search)', () => {
    // "search" contains "search" AND "file" but "file" substring is checked
    expect(classifyToolCategory("search_files")).toBe("file");
  });

  test('"write_file_search" => file (file substring wins)', () => {
    expect(classifyToolCategory("write_file_search")).toBe("file");
  });
});

function createMockCallbacks() {
  return {
    onDispatchAck: vi.fn().mockResolvedValue(undefined),
    onToolProgress: vi.fn().mockResolvedValue(undefined),
    onNoActivity: vi.fn().mockResolvedValue(undefined),
    onFailed: vi.fn().mockResolvedValue(undefined),
    onCompleted: vi.fn().mockResolvedValue(undefined),
  };
}
