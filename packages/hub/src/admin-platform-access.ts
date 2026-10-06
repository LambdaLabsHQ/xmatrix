/**
 * Platform-admin authority for the Hub.
 *
 * Two grants, OR'd, both anchored in deployment configuration:
 *
 * 1. `PLATFORM_ADMIN_SPACE_ID` names one Space whose members are platform
 *    admins. The Space *id* is deployment-owned, so no Space can elect itself;
 *    membership of that one Space is then maintained in-product, which is the
 *    point — adding an operator is an invite, not a deploy.
 * 2. `PLATFORM_ADMIN_EMAILS` is the bootstrap and break-glass allowlist. It is
 *    needed before the admin Space exists and if that Space is ever deleted or
 *    emptied.
 *
 * Consequence of (1), stated so it is never a surprise: anyone who can invite
 * into the admin Space can mint platform admins. Keep that Space closed and
 * owned by the operator who should control the platform-wide read.
 *
 * The email grant is email-based because the Hub's verified identity claim is
 * the auth provider's email. Agent-run principals are never platform admins
 * even when their owner is: an agent token carries delegated Channel authority,
 * not its owner's operator authority.
 */

import type { AuthUser } from "./auth";
import { boundedDeploymentSpaceId, resolveDeploymentSpaceMembership } from "./deployment-space-access";
import type { Env } from "./types";

const MAX_ALLOWLIST_ENTRIES = 64;

export const PLATFORM_ADMIN_REQUIRED_MESSAGE =
  "Platform admin authority is required for this request";

/** Parse the configured allowlist into normalized, deduplicated emails. */
export function platformAdminEmails(env: Pick<Env, "PLATFORM_ADMIN_EMAILS">): string[] {
  const raw = env.PLATFORM_ADMIN_EMAILS;
  if (typeof raw !== "string" || !raw.trim()) return [];
  const emails = new Set<string>();
  for (const entry of raw.split(/[,\s;]+/)) {
    const normalized = normalizeAdminEmail(entry);
    if (!normalized) continue;
    emails.add(normalized);
    if (emails.size >= MAX_ALLOWLIST_ENTRIES) break;
  }
  return [...emails];
}

/** The configured admin Space id, or "" when membership grants nothing. */
export function platformAdminSpaceId(env: Pick<Env, "PLATFORM_ADMIN_SPACE_ID">): string {
  return boundedDeploymentSpaceId(env.PLATFORM_ADMIN_SPACE_ID);
}

/**
 * Allowlist half of the decision. Callers that can reach Relay authority should use
 * `resolvePlatformAdmin` so admin-Space membership is honored too.
 */
export function isPlatformAdminEmail(
  user: Pick<AuthUser, "email"> & { agentRun?: unknown },
  env: Pick<Env, "PLATFORM_ADMIN_EMAILS">,
): boolean {
  // A delegated agent-run token never inherits operator authority.
  if (user.agentRun) return false;
  const email = normalizeAdminEmail(user.email);
  if (!email) return false;
  return platformAdminEmails(env).includes(email);
}

/**
 * Membership of the admin Space is resolved with the ordinary Space read
 * authority: Relay authority answers 404 for a non-member, so this adds no new
 * authorization semantics and cannot be widened by a caller.
 */
export async function resolvePlatformAdmin(
  user: Pick<AuthUser, "id" | "email"> & { agentRun?: unknown },
  env: Pick<Env, "PLATFORM_ADMIN_EMAILS" | "PLATFORM_ADMIN_SPACE_ID">,
  isAdminSpaceMember: (spaceId: string, userId: string) => Promise<boolean>,
): Promise<boolean> {
  if (user.agentRun) return false;
  if (isPlatformAdminEmail(user, env)) return true;
  return resolveDeploymentSpaceMembership(user, platformAdminSpaceId(env), isAdminSpaceMember);
}

function normalizeAdminEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  // Reject anything that is not a plausible single address so a malformed
  // config entry cannot widen the allowlist by accident.
  if (!trimmed || trimmed.length > 320) return "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return "";
  return trimmed;
}
