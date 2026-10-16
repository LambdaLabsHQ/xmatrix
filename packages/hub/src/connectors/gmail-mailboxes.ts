import type { Env } from "../types";
import { upstreamMeter, type UpstreamMeter } from "../usage-cost-metering";
import type { AgentRegistrationIdentity } from "./agent-caller";
import { composioGet, deleteComposioAccount } from "./composio";
import { connectorCredentialRepository } from "./credentials";
import { ProviderRequestError } from "./http";
import { oauthClient } from "./oauth";

/*
 * A Space's Gmail connection holds several mailboxes, each owned by one
 * Space member or one Agent identity (docs/design/connector-platform.md).
 * The list lives only in the connection's encrypted `mailboxes` credential:
 * the Composio account behind each mailbox, its address, and its owner.
 * Every Connect adds a mailbox owned by the admin who connected it; a mailbox
 * connected again replaces its old Composio account and keeps its owner.
 * Space admins reassign or remove mailboxes; nobody else may use one.
 */

export interface GmailMailbox { account: string; address: string; owner: string }

/** Who runs an action: the Human, or an Agent (its registration) and the user whose Run it is. */
export interface GmailCaller { userId: string; agent?: AgentRegistrationIdentity }

export const MAX_MAILBOXES = 10;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{4,128}$/u;
const ADDRESS = /^[^\s@<>(),;:"\\[\]]{1,64}@[^\s@<>(),;:"\\[\]]{1,189}$/u;
const OWNER = /^(?:user:[A-Za-z0-9_.:-]{1,128}|agent:[^/\s]{1,300}\/[^/\s]{1,300}\/[^/\s]{1,300})$/u;
const PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** The stored list; a malformed value fails closed rather than being read in part. */
export function parseMailboxes(value: string | undefined): GmailMailbox[] {
  if (!value) throw new ProviderRequestError(401, "Connect a Gmail mailbox first");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_MAILBOXES) {
    throw new ProviderRequestError(502, "the stored Gmail mailboxes are unreadable; reconnect Gmail");
  }
  return parsed.map((entry) => {
    const { account, address, owner } = (entry ?? {}) as Record<string, unknown>;
    if (typeof account !== "string" || !ACCOUNT_ID.test(account) || typeof address !== "string" || !ADDRESS.test(address) ||
        typeof owner !== "string" || !OWNER.test(owner)) {
      throw new ProviderRequestError(502, "the stored Gmail mailboxes are unreadable; reconnect Gmail");
    }
    return { account, address: address.toLowerCase(), owner };
  });
}

export function serializeMailboxes(mailboxes: readonly GmailMailbox[]): string {
  return JSON.stringify(mailboxes.map(({ account, address, owner }) => ({ account, address, owner })));
}

/** An Agent owner: `agent:` and its registration's owner, machine and harness, each URI-encoded. */
export function agentMailboxOwner(agent: AgentRegistrationIdentity): string {
  return `agent:${[agent.ownerUserId, agent.machineId, agent.harness].map(encodeURIComponent).join("/")}`;
}

/** A member's mailbox serves that member and their Agents' Runs; an Agent's serves only that Agent registration. */
export function mayUseMailbox(mailbox: GmailMailbox, caller: GmailCaller): boolean {
  if (mailbox.owner.startsWith("user:")) return caller.userId === mailbox.owner.slice("user:".length);
  return caller.agent !== undefined && agentMailboxOwner(caller.agent) === mailbox.owner;
}

/** One mailbox's credentials for a proxied call. */
export function mailboxCredentials(credentials: Readonly<Record<string, string>>, mailbox: GmailMailbox): Record<string, string> {
  return { composioApiKey: credentials.composioApiKey ?? "", composioAccountId: mailbox.account };
}

async function mailboxAddress(apiKey: string, account: string, meter: UpstreamMeter): Promise<string> {
  const profile = await composioGet({ composioApiKey: apiKey, composioAccountId: account }, PROFILE, {}, meter);
  const address = typeof profile.emailAddress === "string" ? profile.emailAddress.toLowerCase() : "";
  if (!ADDRESS.test(address)) throw new ProviderRequestError(502, "Google did not confirm the Gmail address");
  return address;
}

function apiKey(env: Env): string {
  const key = oauthClient(env, "gmail")?.clientSecret;
  if (!key) throw new ProviderRequestError(503, "Composio is not configured on this Hub");
  return key;
}

/**
 * The stored list with the account one Connect just created added: a mailbox
 * already present is replaced (its old Composio account deleted) and keeps its
 * owner; a new one belongs to the connecting admin. Past the limit, the new
 * account is deleted and Connect fails.
 */
export async function addConnectedMailbox(env: Env, input: { spaceId: string; actorUserId: string; account: string }):
  Promise<Record<string, string>> {
  const key = apiKey(env);
  if (!ACCOUNT_ID.test(input.account)) throw new ProviderRequestError(400, "Composio did not confirm the Gmail sign-in; restart Connect");
  const meter = upstreamMeter(env, { spaceId: input.spaceId, connector: "gmail", action: "connect" });
  const address = await mailboxAddress(key, input.account, meter);
  const stored = await connectorCredentialRepository(env).resolveForAdmin({ requestId: crypto.randomUUID(),
    spaceId: input.spaceId, providerId: "gmail", actorUserId: input.actorUserId });
  const current = stored?.values.mailboxes ? parseMailboxes(stored.values.mailboxes) : [];
  const replaced = current.filter((mailbox) => mailbox.address === address);
  const kept = current.filter((mailbox) => mailbox.address !== address);
  if (kept.length >= MAX_MAILBOXES) {
    await deleteComposioAccount(key, input.account, meter);
    throw new ProviderRequestError(409, `a Space connects at most ${MAX_MAILBOXES} Gmail mailboxes; remove one first`);
  }
  for (const old of replaced) if (old.account !== input.account) await deleteComposioAccount(key, old.account, meter);
  const owner = replaced[0]?.owner ?? `user:${input.actorUserId}`;
  return { mailboxes: serializeMailboxes([...kept, { account: input.account, address, owner }]) };
}

/** The mailboxes as a Space admin manages them: address and owner, never the Composio account. */
export async function listMailboxes(env: Env, input: { spaceId: string; actorUserId: string }):
  Promise<{ address: string; owner: string }[]> {
  const stored = await connectorCredentialRepository(env).resolveForAdmin({ requestId: crypto.randomUUID(),
    spaceId: input.spaceId, providerId: "gmail", actorUserId: input.actorUserId });
  return stored?.values.mailboxes ? parseMailboxes(stored.values.mailboxes).map(({ address, owner }) => ({ address, owner })) : [];
}

/** Reassigns a mailbox (`owner`) or removes it with its Composio account (`owner: null`). */
export async function updateMailbox(env: Env, input: { spaceId: string; actorUserId: string; address: string; owner: string | null }):
  Promise<{ address: string; owner: string }[]> {
  if (input.owner !== null && !OWNER.test(input.owner)) {
    throw new ProviderRequestError(400, "owner is user:<member id> or agent:<owner>/<machine>/<harness>");
  }
  const repository = connectorCredentialRepository(env);
  const stored = await repository.resolveForAdmin({ requestId: crypto.randomUUID(),
    spaceId: input.spaceId, providerId: "gmail", actorUserId: input.actorUserId });
  const current = stored?.values.mailboxes ? parseMailboxes(stored.values.mailboxes) : [];
  const address = input.address.trim().toLowerCase();
  const target = current.find((mailbox) => mailbox.address === address);
  if (!stored || !target) throw new ProviderRequestError(404, `${address || "that mailbox"} is not connected`);
  const next = input.owner === null ? current.filter((mailbox) => mailbox !== target)
    : current.map((mailbox) => mailbox === target ? { ...mailbox, owner: input.owner! } : mailbox);
  if (input.owner === null) {
    await deleteComposioAccount(apiKey(env), target.account,
      upstreamMeter(env, { spaceId: input.spaceId, connector: "gmail", action: "mailbox_remove" }));
  }
  await repository.put({ requestId: crypto.randomUUID(), spaceId: input.spaceId, providerId: "gmail",
    actorUserId: input.actorUserId, fields: { mailboxes: next.length ? serializeMailboxes(next) : null },
    expectedGrant: stored, policy: { allowed: ["mailboxes"] }, at: new Date().toISOString() });
  return next.map(({ address: entry, owner }) => ({ address: entry, owner }));
}
