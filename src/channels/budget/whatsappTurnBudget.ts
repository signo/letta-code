/**
 * WhatsApp Routed Turn Budget Integration
 *
 * Wires RoutedTurnBudget into WhatsApp routed turn lifecycle:
 * - Instantiates budget at routed turn start
 * - Triggers auto-progress via existing liveness event system
 * - Blocks heavy actions when budget exceeded
 */

import type { ChannelRegistry } from "@/channels/registry";
import type { ChannelTurnSource, WhatsAppChannelAccount } from "@/channels/types";
import { getRoutedTurnBudgetConfig, RoutedTurnBudget } from "./routedTurnBudget";

export interface WhatsAppTurnBudgetOptions {
  account: WhatsAppChannelAccount;
  sources: ChannelTurnSource[];
  registry: ChannelRegistry;
  batchId: string;
  onSendProgressMessage: (message: string) => Promise<void>;
}

/**
 * Create a budget tracker for a WhatsApp routed turn.
 * Returns null if budget is disabled (maxToolCalls = 0).
 */
export function createWhatsAppTurnBudget(
  options: WhatsAppTurnBudgetOptions,
): RoutedTurnBudget | null {
  const { account, sources, registry, batchId, onSendProgressMessage } =
    options;

  // Check if budget is disabled (maxToolCalls = 0 means disabled)
  const maxToolCalls = account.routedTurnMaxToolCalls ?? 8;
  if (maxToolCalls === 0) {
    return null;
  }

  const config = getRoutedTurnBudgetConfig(account);

  return new RoutedTurnBudget(
    config,
    {
      onBudgetExceeded: async (srcs, reason) => {
        console.log(
          `[Channels] routed budget stop: ${reason} sources=${srcs.map((s) => `${s.channel}:${s.chatId}`).join(",")}`,
        );

        // Dispatch failure events via registry
        for (const src of srcs) {
          await registry
            .dispatchTurnLifecycleEvent({
              type: "finished",
              batchId,
              sources: [src],
              outcome: "error",
              error: `Budget exceeded: ${reason}`,
              finishReason: reason as "budget_heavy_bash_exceeded" | "budget_tool_calls_exceeded" | "budget_elapsed_exceeded",
            })
            .catch(() => {});
        }
      },
      onAutoProgress: async (srcs, message) => {
        // Send progress message via adapter
        console.log("[Channels] routed progress: auto message sent");
        await onSendProgressMessage(message);

        // Dispatch tool_waiting liveness event for re-acknowledgment
        for (const src of srcs) {
          await registry
            .dispatchTurnLivenessEvent({
              type: "tool_waiting",
              batchId,
              sources: [src],
              toolCategory: "generic",
            })
            .catch(() => {});
        }
      },
    },
    sources,
  );
}

/**
 * Check if a channel turn source is WhatsApp.
 */
export function isWhatsAppSource(source: ChannelTurnSource): boolean {
  return source.channel === "whatsapp";
}

/**
 * Filter to WhatsApp sources only.
 */
export function getWhatsAppSources(
  sources: ChannelTurnSource[],
): ChannelTurnSource[] {
  return sources.filter(isWhatsAppSource);
}

/**
 * Record a tool call against the budget.
 * Returns false if the call should be blocked.
 */
export function recordToolCall(
  budget: RoutedTurnBudget | null,
  toolName: string,
  args?: Record<string, unknown>,
  sources?: ChannelTurnSource[],
): boolean {
  if (!budget) {
    return true; // Budget disabled, allow all.
  }
  return budget.recordToolCall(toolName, args, sources);
}

/**
 * Mark that an outbound message was sent (cancel auto-progress).
 */
export function noteOutboundSent(budget: RoutedTurnBudget | null): void {
  budget?.noteMessageSent();
}