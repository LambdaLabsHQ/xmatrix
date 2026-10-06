import type { AgentRunPrincipal, AuthUser } from "./auth";

export class BillingReadAccessDenied extends Error {}

/** This is only a route admission gate; every handler must revalidate the live Run. */
export function agentBillingReadRoute(request: Request, principal: AgentRunPrincipal): boolean {
  if (request.method !== "GET" || principal.runKind === "channel-about-session") return false;
  const path = new URL(request.url).pathname;
  const space = /^\/api\/spaces\/([^/]+)\/billing$/.exec(path);
  if (!space) return false;
  try { return decodeURIComponent(space[1]) === principal.spaceId; } catch { return false; }
}

export async function billingReadSubject(
  user: AuthUser,
  revalidate: () => Promise<AgentRunPrincipal>,
  spaceId?: string,
): Promise<{ userId: string; agentRun?: AgentRunPrincipal }> {
  if (!user.agentRun) return { userId: user.id };
  const principal = await revalidate();
  if (!principal.ownerUserId || principal.runKind === "channel-about-session" ||
      (spaceId !== undefined && spaceId !== principal.spaceId)) {
    throw new BillingReadAccessDenied("Agent billing access is limited to its owner and birth Space");
  }
  return { userId: principal.ownerUserId, agentRun: principal };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid billing response");
  return value as Record<string, unknown>;
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = record(value);
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
}

export function agentSpaceStatus(value: unknown): Record<string, unknown> {
  const billing = record(record(value).billing);
  return { billing: {
    ...pick(billing, ["plan", "seatAdjustmentRequired"]),
    subscription: billing.subscription === null ? null : pick(billing.subscription,
      ["status", "seatQuantity", "currentPeriodEnd", "cancelAtPeriodEnd", "graceUntil", "access"]),
    seats: pick(billing.seats, ["used", "limit"]),
    freeUsage: pick(billing.freeUsage, ["acceptedMessages", "limit", "remaining"]),
    canManage: false,
  } };
}
