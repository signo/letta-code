/**
 * Mock WhatsApp socket for testing. Covers only the virtual interface
 * actually used by createWhatsAppAdapter.
 *
 * Usage:
 *   const mockSock = createMockWhatsAppSock({
 *     lidMapping: new Map([["210565536456917", "34600216777"]]),
 *     groupSubjects: new Map([["123456789", "Test Group"]]),
 *   });
 *
 * The adapter accesses `sock.signalRepository?.lidMapping` for LID resolution
 * and `sock.groupMetadata?.()` for group labels.
 */

export interface MockConfig {
  /**
   * Map of LID bare-form (no suffix) → phone JID bare-form (no suffix).
   * resolveLidToPhoneJid in jid.ts reads from
   * sock.signalRepository.lidMapping via stripDeviceSuffix.
   */
  lidMapping?: Map<string, string>;
  /** Map of group bare-form (no suffix) → subject for getGroupLabel. */
  groupSubjects?: Map<string, string>;
}

function stripDeviceSuffix(jid: string): string {
  return jid.replace(/:\d+(@|$)/, "$1");
}

/**
 * Creates a mock sock that satisfies the minimal interface used by the
 * WhatsApp adapter.
 */
export function createMockWhatsAppSock(config?: MockConfig) {
  const groupSubjects = config?.groupSubjects ?? new Map<string, string>();

  return {
    /**
     * Expose the configured lidMapping so `resolveLidToPhoneJid` in jid.ts
     * finds it via `sock.signalRepository.lidMapping`.
     */
    signalRepository: {
      lidMapping: config?.lidMapping ?? new Map<string, string>(),
    },

    /**
     * Provides group subject for getGroupLabel.
     * Defaults to returning undefined (no label).
     */
    groupMetadata: async (
      groupJid: string,
    ): Promise<{ subject: string } | undefined> => {
      const bare = stripDeviceSuffix(groupJid);
      const subject = groupSubjects.get(bare);
      return subject ? { subject } : undefined;
    },
  };
}
