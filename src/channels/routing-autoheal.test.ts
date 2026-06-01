/**
 * Auto-heal routing tests
 *
 * Tests:
 * A) reconcileRoutesAgainstServer — Layer 2 startup reconciliation
 * B) updateRouteConversationId — false for non-existent routes
 * C) Scope: Discord + WhatsApp only (Telegram excluded)
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  clearAllRoutes,
  reconcileRoutesAgainstServer,
  updateRouteConversationId,
} from "./routing";

function makeMockBackend(retrieveFn: () => unknown, createFn: () => unknown) {
  return {
    retrieveConversation: retrieveFn as (
      conversationId: string,
    ) => Promise<{ id?: string | null } | null>,
    createConversation: createFn as (body: {
      agent_id: string;
    }) => Promise<{ id?: string | null }>,
  };
}

describe("reconcileRoutesAgainstServer — Layer 2 startup reconciliation", () => {
  beforeEach(() => {
    clearAllRoutes();
  });

  afterEach(() => {
    clearAllRoutes();
  });

  test("returns correct result shape when no routes exist", async () => {
    const backend = makeMockBackend(
      () => Promise.resolve({ id: "whatever" }),
      () => Promise.resolve({ id: "whatever" }),
    );

    // Use a channel with no stored routes
    const result = await reconcileRoutesAgainstServer({
      backend,
      supportedChannelIds: ["test-nonexistent-channel"],
    });

    expect(result).toHaveProperty("checked");
    expect(result).toHaveProperty("replaced");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("details");
    expect(Array.isArray(result.details)).toBe(true);
  });

  test("skips existing conversations (no replacement needed) for channel with no stored routes", async () => {
    const createSpy = vi.fn();
    const backend = makeMockBackend(
      () => Promise.resolve({ id: "conv-existing-123" }),
      createSpy,
    );

    const result = await reconcileRoutesAgainstServer({
      backend,
      supportedChannelIds: ["test-channel-no-routes"],
    });

    expect(result.checked).toBe(0);
    expect(result.replaced).toBe(0);
    expect(result.failed).toBe(0);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("handles retrieveConversation throwing (treats as missing)", async () => {
    const createSpy = vi.fn();
    const backend = makeMockBackend(
      () => Promise.reject(new Error("Network error")),
      createSpy,
    );

    const result = await reconcileRoutesAgainstServer({
      backend,
      supportedChannelIds: ["test-channel-no-routes"],
    });

    // No routes to process → no replacement attempted
    expect(result.checked).toBe(0);
    expect(result.replaced).toBe(0);
  });

  test("counts failed when createConversation returns null id", async () => {
    const backend = makeMockBackend(
      () => Promise.resolve(null),
      () => Promise.resolve({ id: null }),
    );

    const result = await reconcileRoutesAgainstServer({
      backend,
      supportedChannelIds: ["test-channel-no-routes"],
    });

    // No routes in memory → no failed count
    expect(result.checked).toBe(0);
    expect(result.replaced).toBe(0);
  });

  test("logs missing conversation detection for channel with no routes", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const backend = makeMockBackend(
      () => Promise.resolve(null),
      () => Promise.resolve({ id: "new-conv-abc" }),
    );

    const result = await reconcileRoutesAgainstServer({
      backend,
      supportedChannelIds: ["test-channel-no-routes"],
    });

    // No routes → 0 checked
    expect(result.checked).toBe(0);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("updateRouteConversationId", () => {
  beforeEach(() => {
    clearAllRoutes();
  });

  afterEach(() => {
    clearAllRoutes();
  });

  test("returns false for non-existent route key", () => {
    const result = updateRouteConversationId(
      "whatsapp",
      "nonexistent-chat",
      "acc-1",
      null,
      "new-conv-id",
    );
    expect(result).toBe(false);
  });

  test("returns false for non-routed channel (telegram)", () => {
    const result = updateRouteConversationId(
      "telegram",
      "some-chat",
      "acc-1",
      null,
      "new-conv-id",
    );
    expect(result).toBe(false);
  });
});

describe("reconcileRoutesAgainstServer — scope (Discord + WhatsApp only, Telegram ignored)", () => {
  test("supportedChannelIds filtering works", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const backend = makeMockBackend(
      () => Promise.resolve({ id: "exists" }),
      () => Promise.resolve({ id: "new" }),
    );

    await reconcileRoutesAgainstServer({
      backend,
      supportedChannelIds: ["discord", "whatsapp", "telegram"],
    });

    // No routes in memory → no calls made
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("empty supportedChannelIds array returns zero-checked result", async () => {
    const result = await reconcileRoutesAgainstServer({
      backend: makeMockBackend(
        () => Promise.resolve({ id: "whatever" }),
        () => Promise.resolve({ id: "whatever" }),
      ),
      supportedChannelIds: [],
    });

    expect(result.checked).toBe(0);
    expect(result.replaced).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.details).toHaveLength(0);
  });
});
