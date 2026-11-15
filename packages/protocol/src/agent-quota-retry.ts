import type { SpaceAgentRegistrationKey } from "./agent-registration.js";

/** A server-owned offer. Reading it never selects automatic recovery. */
export interface AgentQuotaRetry {
  id: string;
  state: "offered" | "waiting" | "dispatching" | "dispatched" | "cancelled" | "expired" | "failed";
  canChoose: boolean;
  expiresAt: string;
  nextCheckAt?: string;
  failureMessage?: string;
}

export interface AgentQuotaRetryAdmission { id: string; generation: number }

export const AGENT_QUOTA_RETRY_NOTICE_KIND = "xmatrix.quota-retry-offer";

export function quotaRetryOfferId(metadata: Record<string, unknown> | undefined): string | undefined {
  const id = metadata?.xmatrixQuotaRetryId;
  return metadata?.kind === AGENT_QUOTA_RETRY_NOTICE_KIND && typeof id === "string" &&
    /^[a-f0-9]{64}$/u.test(id) ? id : undefined;
}

/** The model a quota retry waits on for one registration: the account
 * windows and the scoped windows of its `quotaScopes` decide when it may
 * start. `model` is as the launch named it (empty for the runtime's default). */
export interface QuotaRetryModel { model: string; quotaScopes: string[] }

/** A registration a quota retry waits on, with the model it would run. */
export type QuotaRetryRegistration = SpaceAgentRegistrationKey & { model?: QuotaRetryModel };
