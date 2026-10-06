/**
 * Platform admin overview contract.
 *
 * The overview is a read-only, platform-wide aggregate served to operators on
 * the Hub admin allowlist. It never carries message bodies, attachment
 * payloads, or any other Channel content: counts, identities, and timestamps
 * only, so operating the platform does not require a content-read authority.
 */

/**
 * Hub and web-proxy routes for the admin overview. They live with the rest of
 * the admin contract instead of the shared route maps so the operator surface
 * stays one reviewable module.
 */
export const ADMIN_OVERVIEW_HUB_ROUTE = "/api/admin/overview";
export const ADMIN_OVERVIEW_WEB_ROUTE = "/api/xmatrix/admin/overview";

/**
 * Mint `@` addresses for accounts created before handles existed. An operator
 * action rather than a migration because the handle a name produces is decided
 * in code, and because it is bounded and re-run until it reports no more.
 */
export const ADMIN_HUMAN_HANDLE_BACKFILL_HUB_ROUTE = "/api/admin/human-handle-backfill";

/** Accounts minted per call. Bounded so one request cannot outrun its budget. */
export const ADMIN_HANDLE_BACKFILL_DEFAULT_LIMIT = 100;
export const ADMIN_HANDLE_BACKFILL_MAX_LIMIT = 500;

export function adminHandleBackfillLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return ADMIN_HANDLE_BACKFILL_DEFAULT_LIMIT;
  return Math.min(Math.floor(value), ADMIN_HANDLE_BACKFILL_MAX_LIMIT);
}

export interface AdminPlatformTotals {
  users: number;
  spaces: number;
  channels: number;
  activeChannels: number;
  archivedChannels: number;
  messages: number;
  messagesLast24h: number;
  messagesLast7d: number;
  humanMessages: number;
  agentMessages: number;
  agentRegistrations: number;
  runs: number;
  activeRuns: number;
  agentInstances: number;
  machines: number;
  onlineMachines: number;
  scheduledTasks: number;
  enabledScheduledTasks: number;
  storageLogicalBytes: number;
  archivedSegmentBytes: number;
}

export interface AdminSpaceSummary {
  id: string;
  name: string;
  ownerUserId: string;
  ownerEmail?: string;
  members: number;
  channels: number;
  activeChannels: number;
  agentRegistrations: number;
  messages: number;
  messagesLast7d: number;
  createdAt: string;
  lastMessageAt?: string;
}

export interface AdminUserSummary {
  userId: string;
  name?: string;
  handle?: string;
  email?: string;
  spaces: number;
  ownedSpaces: number;
  agentRegistrations: number;
  machines: number;
  messages: number;
  registeredAt?: string;
  lastSessionAt?: string;
  sessionCount?: number;
  activeSessions?: number;
  emailVerified?: boolean;
  profileCompleted?: boolean;
  providers?: string[];
  firstSeenAt?: string;
  lastMessageAt?: string;
}

/** Authentication-directory metrics. Session activity is not a page-view count. */
export interface AdminUserAccessSummary {
  registeredUsers: number;
  emailVerifiedUsers: number;
  completedProfiles: number;
  activeUsersLast24h: number;
  activeUsersLast7d: number;
  activeUsersLast30d: number;
}

/** One UTC day of platform message volume, oldest first. */
export interface AdminActivityPoint {
  date: string;
  messages: number;
  humanMessages: number;
  agentMessages: number;
}

export interface AdminStorageCategory {
  category: string;
  rows: number;
  logicalBytes: number;
  updatedAt: string;
}

export interface AdminPlatformOverview {
  generatedAt: string;
  /** UTC days covered by `activity`. */
  activityDays: number;
  totals: AdminPlatformTotals;
  spaces: AdminSpaceSummary[];
  users: AdminUserSummary[];
  /** Present when the authentication directory could be read. */
  userAccess?: AdminUserAccessSummary;
  activity: AdminActivityPoint[];
  storage: AdminStorageCategory[];
  /** True when a bounded part of the overview was cut off. */
  truncated: {
    spaces: boolean;
    users: boolean;
    /** Message totals, activity, and per-Space/user message counts are partial. */
    messageMetrics?: boolean;
  };
}

/** Maximum Space rows the Hub will return. */
export const ADMIN_OVERVIEW_MAX_ROWS = 200;

/** Complete user inventory bound. A proven overflow fails instead of truncating silently. */
export const ADMIN_OVERVIEW_MAX_USER_ROWS = 10_000;

/** Default rows returned when the caller does not ask for a specific limit. */
export const ADMIN_OVERVIEW_DEFAULT_ROWS = 50;

/** Maximum days of daily activity the Hub will aggregate in one read. */
export const ADMIN_OVERVIEW_MAX_ACTIVITY_DAYS = 90;

export const ADMIN_OVERVIEW_DEFAULT_ACTIVITY_DAYS = 14;

export function adminOverviewRowLimit(value: unknown): number {
  return boundedAdminNumber(value, ADMIN_OVERVIEW_DEFAULT_ROWS, 1, ADMIN_OVERVIEW_MAX_ROWS);
}

export function adminOverviewUserLimit(value: unknown): number {
  return boundedAdminNumber(
    value,
    ADMIN_OVERVIEW_DEFAULT_ROWS,
    1,
    ADMIN_OVERVIEW_MAX_USER_ROWS,
  );
}

export function adminOverviewActivityDays(value: unknown): number {
  return boundedAdminNumber(
    value,
    ADMIN_OVERVIEW_DEFAULT_ACTIVITY_DAYS,
    1,
    ADMIN_OVERVIEW_MAX_ACTIVITY_DAYS,
  );
}

function boundedAdminNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
