export interface BackendAgentAdminCapabilities {
  readonly list: true;
  readonly retrieve: true;
  readonly update: true;
}

export const BACKEND_AGENT_ADMIN_CAPABILITIES: BackendAgentAdminCapabilities =
  Object.freeze({
    list: true as const,
    retrieve: true as const,
    update: true as const,
  });
