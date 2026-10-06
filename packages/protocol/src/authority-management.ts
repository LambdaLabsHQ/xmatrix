// --- Channel ---

export type ChannelMode = "open" | "closed";
/** A participant takes part in an open project without a member's reach (docs/design/open-project-governance.md). */
export type SpaceRole = "owner" | "admin" | "member" | "viewer" | "participant";
export type ManagementChannelVisibility =
  | "management-visible"
  | "metadata-only"
  | "excluded";

export interface SpaceManagementAgentConfig {
  enabled: boolean;
  /**
   * Human-owned emergency fuse for management side effects. Disabling it does
   * not disable read-only management events, diagnosis, or action audit reads.
   */
  sideEffectsEnabled: boolean;
  /**
   * Product persona shown to users. Reserved by xMatrix; callers may omit it.
   */
  identityName: "xMatrix";
  /** This Space's own management prompt; absent means the platform template. */
  prompt?: string;
  managementChannelId?: string;
  defaultChannelVisibility: ManagementChannelVisibility;
  /** CAS version of the complete Space-owned management configuration. */
  configVersion?: number;
  trustLevels?: SpaceManagementTrustLevelState[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface SpaceManagementTrustLevelState {
  decisionClass: string;
  actionType: string;
  level: "L0" | "L1" | "L2" | "L3";
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * Stored management config keys that no longer mean anything: a per-Space
 * prompt override from v0.16.93, and the configured management Agent that Jev
 * selection replaced. Readers drop them and every write compacts them away.
 */
export const RETIRED_MANAGEMENT_CONFIG_KEYS = ["focusReviewPrompt", "agentId", "agentName"] as const;

export function withoutRetiredManagementConfig<T extends Record<string, unknown>>(config: T): T {
  const next = { ...config };
  for (const key of RETIRED_MANAGEMENT_CONFIG_KEYS) delete next[key];
  return next;
}
