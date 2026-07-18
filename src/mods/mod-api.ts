import type Letta from "@letta-ai/letta-client";
import type { PiProviderRegistration } from "@/backend/dev/pi-provider-mod-registry";
import type { ModBackendApi } from "@/mods/backend-agent-admin";
import type {
  ModCapabilities,
  ModCommandRegistration,
  ModDiagnosticReportOptions,
  ModEventHandler,
  ModEventName,
  ModPanelHandle,
  ModPanelOptions,
  ModPermissionRegistration,
  ModToolRegistration,
} from "@/mods/types";

export type LettaModDisposer = () => void;

export interface LettaModApi {
  capabilities: ModCapabilities;
  backend: ModBackendApi;
  client: Letta;
  getClient: () => Promise<Letta>;
  signal: AbortSignal;
  registerProvider: (
    name: string,
    config: PiProviderRegistration,
  ) => LettaModDisposer;
  unregisterProvider: (name: string) => void;
  commands: {
    register: (command: ModCommandRegistration) => LettaModDisposer;
    unregister: (id: string) => void;
  };
  tools: {
    register: (tool: ModToolRegistration) => LettaModDisposer;
    unregister: (name: string) => void;
  };
  providers: {
    register: (
      name: string,
      config: PiProviderRegistration,
    ) => LettaModDisposer;
    unregister: (name: string) => void;
  };
  events: {
    off: <TName extends ModEventName>(
      name: TName,
      handler: ModEventHandler<TName>,
    ) => void;
    on: <TName extends ModEventName>(
      name: TName,
      handler: ModEventHandler<TName>,
    ) => LettaModDisposer;
  };
  permissions: {
    register: (permission: ModPermissionRegistration) => LettaModDisposer;
    unregister: (id: string) => void;
  };
  diagnostics: {
    report: (diagnostic: ModDiagnosticReportOptions) => void;
  };
  ui: {
    closePanel: (id: string) => void;
    openPanel: (panel: ModPanelOptions) => ModPanelHandle;
    /** @deprecated Removed. Use openPanel; calls emit a migration diagnostic. */
    setStatus: (key: string, value?: unknown) => void;
    /** @deprecated Removed. Use openPanel; calls emit a migration diagnostic. */
    clearStatus: (key: string) => void;
    /** @deprecated Removed. Use openPanel; calls emit a migration diagnostic. */
    setStatuslineRenderer: (renderer: unknown) => void;
  };
}

export type LettaModFactory = (
  letta: LettaModApi,
) => undefined | LettaModDisposer | Promise<undefined | LettaModDisposer>;
