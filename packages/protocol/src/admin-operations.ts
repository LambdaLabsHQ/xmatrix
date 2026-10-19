/**
 * Platform admin: one Space's detail, and the platform's operations.
 *
 * Like the overview and user detail these are metadata only — identities,
 * roles, counts, statuses, kinds, and timestamps. Message and page text,
 * Automation prompts and error text, connector payloads and errors, secret
 * values, billing provider ids and payloads, Machine host and display names,
 * and every `metadata_json` never appear here.
 */

export const ADMIN_SPACE_DETAIL_HUB_ROUTE = "/api/admin/spaces/:spaceId";
export const ADMIN_SPACE_DETAIL_WEB_ROUTE = "/api/xmatrix/admin/spaces";

export function adminSpaceDetailHubRoute(spaceId: string): string {
  return ADMIN_SPACE_DETAIL_HUB_ROUTE.replace(":spaceId", encodeURIComponent(spaceId));
}

export function adminSpaceDetailWebRoute(spaceId: string): string {
  return `${ADMIN_SPACE_DETAIL_WEB_ROUTE}/${encodeURIComponent(spaceId)}`;
}

/** Days of Space activity, Run, Automation and paid-call history in the detail. */
export const ADMIN_SPACE_DETAIL_DAYS = 30;
/** Rows per list in the Space detail; a list at the bound says so instead of growing. */
export const ADMIN_SPACE_DETAIL_MAX_ROWS = 200;

export interface AdminSpaceMember {
  userId: string;
  email?: string;
  role: string;
  joinedAt: string;
  /** Messages this member wrote in the Space. */
  messages: number;
}

export interface AdminSpaceAgent {
  machineId: string;
  harness: string;
  displayName: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSpaceConnector {
  providerId: string;
  providerName: string;
  status: string;
  authMode: string;
  createdBy?: string;
  createdAt: string;
  lastCheckedAt?: string;
}

export interface AdminSpaceAutomationSummary {
  total: number;
  enabled: number;
  /** Automations whose last run recorded an error; the error text is not shown. */
  withError: number;
  runCount: number;
  lastRunAt?: string;
  /** Occurrences scheduled in the window, by status. */
  occurrencesByStatus: Record<string, number>;
}

export interface AdminSpaceBillingDetail {
  plan: string;
  status: string;
  seats: number;
  provider: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
  graceUntil?: string;
  updatedAt: string;
}

export interface AdminBillingWebhookEvent {
  spaceId: string;
  eventType: string;
  outcome: string;
  processedAt: string;
}

export interface AdminPaidCallKind {
  kind: string;
  calls: number;
  /** Calls by outcome: ok, rejected, uncertain, or reserved while still open. */
  byOutcome: Record<string, number>;
  units: number;
  credits: number;
}

export interface AdminSpaceDetail {
  generatedAt: string;
  space: {
    spaceId: string;
    name: string;
    ownerUserId: string;
    ownerEmail?: string;
    createdAt: string;
    lastMessageAt?: string;
  };
  totals: {
    members: number;
    channels: number;
    agents: number;
    messages: number;
    messagesLast7d: number;
    messagesLast30d: number;
    humanMessages: number;
    agentMessages: number;
    pages: number;
    storageLogicalBytes: number;
    activeInvites: number;
    pendingJoinRequests: number;
  };
  members: AdminSpaceMember[];
  agents: AdminSpaceAgent[];
  connectors: AdminSpaceConnector[];
  automations: AdminSpaceAutomationSummary;
  /** Runs started in the window, by status. */
  runs: { total: number; byStatus: Record<string, number>; lastRunAt?: string };
  billing?: AdminSpaceBillingDetail;
  /** Free-plan messages counted against the allowance. */
  freeMessages: number;
  webhookEvents: AdminBillingWebhookEvent[];
  paidCalls: AdminPaidCallKind[];
  storage: Array<{ category: string; rows: number; logicalBytes: number }>;
  /** Messages per UTC day, oldest first. */
  activity: Array<{ date: string; messages: number; humanMessages: number; agentMessages: number }>;
  /** Lists that reached `ADMIN_SPACE_DETAIL_MAX_ROWS`. */
  truncated: string[];
}

/**
 * The platform's moving parts: Machines and Agents, Runs, Automations,
 * delivery backlog, billing, and the calls xMatrix pays for.
 */
export const ADMIN_OPERATIONS_HUB_ROUTE = "/api/admin/operations";
export const ADMIN_OPERATIONS_WEB_ROUTE = "/api/xmatrix/admin/operations";

/** Days of Run, Automation, webhook and paid-call history in operations. */
export const ADMIN_OPERATIONS_DAYS = 30;
/** Rows per list in operations; a list at the bound says so instead of growing. */
export const ADMIN_OPERATIONS_MAX_ROWS = 1_000;

export interface AdminOperationsMachine {
  machineId: string;
  ownerUserId: string;
  ownerEmail?: string;
  status: string;
  /** Agent registrations bound to this Machine, across Spaces. */
  agents: number;
  /** Runs on this Machine that are starting, running, or stopping. */
  activeRuns: number;
  enrolledAt: string;
  lastSeenAt: string;
}

export interface AdminOperationsHarness {
  harness: string;
  agents: number;
  spaces: number;
  owners: number;
}

export interface AdminOperationsRunDay {
  date: string;
  started: number;
  failed: number;
}

export interface AdminOperationsSubscription {
  spaceId: string;
  spaceName: string;
  plan: string;
  status: string;
  seats: number;
  provider: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
  graceUntil?: string;
  updatedAt: string;
}

export interface AdminOperations {
  generatedAt: string;
  days: number;
  machines: AdminOperationsMachine[];
  machinesByStatus: Record<string, number>;
  harnesses: AdminOperationsHarness[];
  runs: {
    active: number;
    /** Runs started in the window, by status. */
    byStatus: Record<string, number>;
    daily: AdminOperationsRunDay[];
  };
  automations: {
    total: number;
    enabled: number;
    withError: number;
    /** Occurrences scheduled in the window, by status. */
    occurrencesByStatus: Record<string, number>;
    /** Pending occurrences already past their scheduled time. */
    overdue: number;
  };
  /** Event delivery queue, by status, and the oldest undelivered event. */
  outbox: { byStatus: Record<string, number>; oldestPendingAt?: string; maxAttempts: number };
  billing: {
    subscriptions: AdminOperationsSubscription[];
    byStatus: Record<string, number>;
    webhookEvents: AdminBillingWebhookEvent[];
    webhooksByOutcome: Record<string, number>;
  };
  paidCalls: AdminPaidCallKind[];
  /** Lists that reached `ADMIN_OPERATIONS_MAX_ROWS`. */
  truncated: string[];
}
