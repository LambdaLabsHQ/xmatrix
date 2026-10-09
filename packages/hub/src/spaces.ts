import {
  PostgresChannelCatalogRepository,
  PostgresSpaceControlRepository,
  type AuthorityDatabase,
  type AccountSpaceClosureAuthorization,
  type ChannelCatalogChangeAudience,
  type PostgresChannelMutation,
  type PostgresMembershipMutation,
  type SpaceControlPrincipal,
} from "@xmatrix/db";

import { withChannelHeadPreview } from "./channel-head-preview";
import {
  createPostgresAuthorityDatabase,
  createPostgresAuthorityFleet,
  type PostgresAuthorityFleetEnv,
} from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS, postgresAuthorityShardId } from "./postgres-authority-http";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { wakeRegistrationChannels } from "./registration-authority-wake";
import { projectRegistrationQuota } from "./registration-quota-presentation";
import { relayChannelCatalogPublishCommittedChanges } from "./relay-channel-catalog-notification-delivery";
import { notifyWorkspaceResource } from "./workspace-resource-notification";
import type { Env } from "./types";

export interface SpacesEnv extends PostgresAuthorityFleetEnv {
  RELAY_POSTGRES?: { connectionString: string };
  RELAY_POSTGRES_SHARD_ID?: string;
  RELAY_RUNTIME?: Env["RELAY_RUNTIME"];
  RELAY_RUNTIME_ROUTE_DIRECTORY?: Env["RELAY_RUNTIME_ROUTE_DIRECTORY"];
  XMATRIX_RUNTIME_CELL_MODE?: Env["XMATRIX_RUNTIME_CELL_MODE"];
  RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL?: DurableObjectNamespace;
}

/** Test seams: a database, and the after-commit catalog notice and Channel wake. */
export interface SpacesDependencies {
  database?: AuthorityDatabase;
  directoryDatabase?: AuthorityDatabase;
  publishCatalogChanges?: (changes: readonly ChannelCatalogChangeAudience[]) => Promise<void>;
  /** Tells the Channels whose running executions an authority change may withdraw. */
  wakeAffectedChannels?: (database: AuthorityDatabase, spaceId: string) => Promise<unknown>;
  /** Tells these Channels to recheck their running executions. */
  recheckChannels?: (channelIds: readonly string[]) => Promise<unknown>;
}

type Principal = SpaceControlPrincipal;

/** Spaces, their Channels and members live on the Space shards. */
function spaces(env: SpacesEnv, dependencies: SpacesDependencies = {}, commandId?: string) {
  const shardId = postgresAuthorityShardId(env, "Channel catalog authority");
  const database = dependencies.database ?? createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-channel-catalog", ...POSTGRES_AUTHORITY_TIMEOUTS,
  });
  return {
    repository: new PostgresSpaceControlRepository(database, shardId),
    database,
    requestId: commandId?.trim() || crypto.randomUUID(),
  };
}

/**
 * Tells the Spaces' live readers their Channel catalog changed. The mutation
 * has committed: realtime invalidation is an acceleration path and cannot turn
 * a successful command into a retry.
 */
async function publishCatalogChanges(env: SpacesEnv, dependencies: SpacesDependencies,
  repository: PostgresSpaceControlRepository, requestId: string, spaceIds: readonly string[]): Promise<void> {
  if (!dependencies.publishCatalogChanges && !env.RELAY_RUNTIME) return;
  try {
    const changes = await repository.channelCatalogChangeAudiences({ requestId, spaceIds });
    if (dependencies.publishCatalogChanges) await dependencies.publishCatalogChanges(changes);
    else await relayChannelCatalogPublishCommittedChanges({ env: env as Pick<Env, "RELAY_RUNTIME" |
      "RELAY_RUNTIME_ROUTE_DIRECTORY" | "XMATRIX_RUNTIME_CELL_MODE">, changes });
  } catch (error) {
    console.error("PostgreSQL Channel catalog notification failed", error);
  }
}

/** Channels whose running executions an authority change in the Space may withdraw recheck them. */
function wakeAffectedChannels(env: SpacesEnv, dependencies: SpacesDependencies, database: AuthorityDatabase,
  spaceId: string): Promise<unknown> {
  return (dependencies.wakeAffectedChannels ??
    ((wakeDatabase, wakeSpaceId) => wakeRegistrationChannels(env, wakeDatabase, { spaceId: wakeSpaceId })))(
    database, spaceId);
}

/** Registration quota shown beside the Channels' Agents. */
async function projectQuota(env: SpacesEnv, dependencies: SpacesDependencies, requestId: string,
  channels: readonly Record<string, unknown>[]): Promise<void> {
  if (!channels.some((channel) => Object.values((channel.memberPresence ?? {}) as
    Record<string, { registration?: unknown }>).some((presence) => presence.registration))) return;
  const directory = dependencies.directoryDatabase ?? dependencies.database ?? createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-quota-presentation", ...POSTGRES_AUTHORITY_TIMEOUTS,
  }).directoryDatabase;
  await projectRegistrationQuota(directory, channels, requestId);
}

// Spaces

export function createSpace(env: SpacesEnv, input: {
  commandId: string; spaceId: string; ownerUserId: string; name: string; metadata?: Record<string, unknown>;
}) {
  const { repository, requestId } = spaces(env, {}, input.commandId);
  return repository.createSpace({ requestId, ...input });
}

interface DomainCommand { commandId: string; actorUserId: string; at: string; expectedVersion?: number }

/** Renames a Space or changes its metadata. */
export function updateSpace(env: SpacesEnv, input: DomainCommand & {
  spaceId: string; name?: string; metadata?: Record<string, unknown>;
}) {
  const { repository, requestId } = spaces(env, {}, input.commandId);
  return repository.mutateSpace({ requestId, kind: "space_update", ...input });
}

/** Deletes a Space; it stays restorable for its retention window. */
export function deleteSpace(env: SpacesEnv, input: DomainCommand & { spaceId: string; accountClosure?: AccountSpaceClosureAuthorization }) {
  const { repository, requestId } = spaces(env, {}, input.commandId);
  return repository.mutateSpace({ requestId, kind: "space_delete", ...input });
}

export function restoreSpace(env: SpacesEnv, input: DomainCommand & { spaceId: string }) {
  const { repository, requestId } = spaces(env, {}, input.commandId);
  return repository.restoreSpace({ requestId, ...input });
}

/** The Spaces a Human deleted that can still be restored. */
export function listSpaceDeletions(env: SpacesEnv, ownerUserId: string) {
  const { repository, requestId } = spaces(env);
  return repository.listSpaceDeletions({ requestId, ownerUserId });
}

/** A Space as its reader may see it. */
export function getSpace(env: SpacesEnv, input: { spaceId: string; principal: Principal }) {
  const { repository, requestId } = spaces(env);
  return repository.getSpace({ requestId, ...input });
}

/**
 * Live Agent presence in the named Spaces, read from Instance rows. Each Space
 * is its own placement; a Space the principal cannot read fails the call.
 */
export async function readVisibleLiveAgentPresence(
  env: SpacesEnv,
  principal: Principal,
  spaceIds: readonly string[],
): Promise<Map<string, Record<string, import("@xmatrix/protocol").ChannelMemberPresence>>> {
  const ids = [...new Set(spaceIds.map((spaceId) => spaceId.trim()).filter(Boolean))];
  const merged = new Map<string, Record<string, import("@xmatrix/protocol").ChannelMemberPresence>>();
  for (let offset = 0; offset < ids.length; offset += 4) {
    const page = await Promise.all(ids.slice(offset, offset + 4).map(async (spaceId) => {
      const { repository } = spaces(env);
      return repository.listLiveAgentPresence({
        requestId: crypto.randomUUID(), spaceId, principal,
      });
    }));
    for (const found of page) {
      for (const [channelId, presence] of found) merged.set(channelId, presence);
    }
  }
  return merged;
}

/** Every Space a principal belongs to, following the cursor. */
export async function listSpaces(env: SpacesEnv, principal: Principal): Promise<Record<string, unknown>[]> {
  const { repository } = spaces(env);
  const all: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.listSpaces({ requestId: crypto.randomUUID(), principal, limit: 200,
      ...(cursor ? { cursor } : {}) });
    all.push(...page.spaces);
    cursor = typeof page.cursor === "string" && page.cursor ? page.cursor : undefined;
  } while (cursor);
  return all;
}

// Channels

export async function createChannel(env: SpacesEnv, input: {
  commandId: string; channelId: string; spaceId: string; name: string; mode: "open" | "closed";
  principal: Principal; metadata?: Record<string, unknown>; creatorAgentInstanceId?: string;
}, dependencies: SpacesDependencies = {}) {
  const { repository, requestId } = spaces(env, dependencies, input.commandId);
  const created = await repository.createChannel({ requestId, ...input });
  await publishCatalogChanges(env, dependencies, repository, requestId, [input.spaceId]);
  return created;
}

/**
 * Changes a Channel's name, mode, topic, summary or Space. Its mode and its
 * Space decide what the executions running in it (and in the threads a move
 * takes along) may do, so a change to either has those Channels recheck them;
 * a name, topic or summary decides nothing and wakes none (2026-10-09: every
 * summary an About session wrote rechecked each Channel of its Space). The
 * answer is the Channel as its actor now reads it.
 */
export async function configureChannel(env: SpacesEnv,
  input: Omit<PostgresChannelMutation, "requestId" | "kind">, dependencies: SpacesDependencies = {},
): Promise<Record<string, unknown> & { channel: unknown }> {
  const { repository, requestId } = spaces(env, dependencies, input.commandId);
  const mutation: PostgresChannelMutation = { ...input, requestId, kind: "channel_configure" };
  const sourceSpaceId = await repository.resolveChannelSpaceId({ requestId, channelId: input.channelId });
  const result = await repository.mutateChannel(mutation, undefined, sourceSpaceId);
  const targetSpaceId = input.spaceId?.trim() || sourceSpaceId;
  await publishCatalogChanges(env, dependencies, repository, requestId,
    sourceSpaceId === targetSpaceId ? [sourceSpaceId] : [sourceSpaceId, targetSpaceId]);
  if (input.mode !== undefined || targetSpaceId !== sourceSpaceId) {
    const channelIds = [input.channelId, ...(input.moveTree ?? []).map((item) => item.channelId)];
    await (dependencies.recheckChannels ?? ((ids) => Promise.all(ids.map((channelId) =>
      wakeAgentLaunchCoordinator(env, channelId, ["registrationStop"])))))(channelIds);
  }
  // A move changes the Channel's route; read it where it is now.
  const configured = await repository.getChannel({
    requestId, spaceId: await repository.resolveChannelSpaceId({ requestId, channelId: input.channelId }),
    channelId: input.channelId, principal: { kind: "user", id: input.actorUserId },
  });
  return { ...result, channel: configured.channel };
}

export async function createChannelTransfer(env: SpacesEnv, input: {
  proposalId: string; channelId: string; targetSpaceId: string; principal: Principal;
}) {
  const { repository, requestId } = spaces(env);
  const result = await repository.createTransferProposal({ requestId, ...input });
  await notifyTransferQueues(env, result.proposal);
  return result;
}

/** Both Spaces see a completed transfer's Channel move. */
export async function acknowledgeChannelTransfer(env: SpacesEnv, input: {
  sourceSpaceId: string; proposalId: string; role: "outbound" | "inbound"; principal: Principal;
}) {
  const { repository, requestId } = spaces(env);
  const result = await repository.acknowledgeTransferProposal({ requestId, ...input });
  const proposal = result.proposal && typeof result.proposal === "object"
    ? result.proposal as Record<string, unknown> : undefined;
  if (proposal?.status === "completed" && typeof proposal.sourceSpaceId === "string" &&
      typeof proposal.targetSpaceId === "string") {
    await publishCatalogChanges(env, {}, repository, requestId, [proposal.sourceSpaceId, proposal.targetSpaceId]);
  }
  // The queue changes on the first acknowledgement, before the move completes.
  await notifyTransferQueues(env, proposal);
  return result;
}

function notifyTransferQueues(env: SpacesEnv, proposal: unknown): Promise<void> {
  if (!proposal || typeof proposal !== "object") return Promise.resolve();
  const record = proposal as Record<string, unknown>;
  const spaceIds = [record.sourceSpaceId, record.targetSpaceId].filter((spaceId): spaceId is string =>
    typeof spaceId === "string" && spaceId.length > 0);
  if (spaceIds.length === 0) return Promise.resolve();
  return notifyWorkspaceResource(env, {
    spaceIds, resource: "channel_transfers",
    ...(typeof record.channelId === "string" ? { channelId: record.channelId } : {}),
  });
}

export function listChannelTransfers(env: SpacesEnv, input: { spaceId: string; principal: Principal; channelId?: string }) {
  const { repository, requestId } = spaces(env);
  return repository.listTransferProposals({ requestId, ...input });
}

/**
 * A Channel as its reader may see it, in its own Space unless one is named.
 * `purpose` names a non-request read path (a live fanout) in its observation.
 */
export async function getChannel(env: SpacesEnv, input: {
  channelId: string; principal: Principal; spaceId?: string; purpose?: string;
}, dependencies: SpacesDependencies = {}) {
  const { repository, requestId } = spaces(env, dependencies);
  const suffix = input.purpose ? `.${input.purpose}` : "";
  const spaceId = input.spaceId ?? await repository.resolveChannelSpaceId({ requestId, channelId: input.channelId,
    operation: `channel.resolve-space${suffix}` });
  const result = await repository.getChannel({ requestId, spaceId, channelId: input.channelId,
    principal: input.principal, operation: `channel.get${suffix}` });
  await projectQuota(env, dependencies, requestId, [result.channel as Record<string, unknown>]);
  return result;
}

/** One page of a Space's Channels, or a Channel and its thread family. */
export async function listChannels(env: SpacesEnv, input: {
  principal: Principal; spaceId?: string; channelId?: string; familyOfChannelId?: string;
  cursor?: string; limit?: number;
}, dependencies: SpacesDependencies = {}) {
  const { repository, requestId } = spaces(env, dependencies);
  const { spaceId: named, ...selection } = input;
  const routingChannelId = input.channelId ?? input.familyOfChannelId;
  const spaceId = named ?? (routingChannelId
    ? await repository.resolveChannelSpaceId({ requestId, channelId: routingChannelId }) : undefined);
  if (!spaceId) throw new TypeError("listChannels needs a Space or a Channel");
  const result = await repository.listChannels({ requestId, spaceId, ...selection });
  await projectQuota(env, dependencies, requestId, result.channels);
  return result;
}

type CatalogPage = Parameters<PostgresChannelCatalogRepository["page"]>[0];

/** One page of the Channel list view, search or intake as the reader sees it. */
export async function channelCatalogPage(env: SpacesEnv, input: Omit<CatalogPage, "requestId">,
  dependencies: SpacesDependencies = {}) {
  const { database, requestId } = spaces(env, dependencies);
  const page = await new PostgresChannelCatalogRepository(database).page({ requestId, ...input });
  const rows = page.rows as { channel: Record<string, unknown> }[];
  await projectQuota(env, dependencies, requestId, rows.map((row) => row.channel));
  return { ...page, rows: rows.map((row) => ({ ...row, channel: withChannelHeadPreview(row.channel) })) };
}

type CatalogResolution = Parameters<PostgresChannelCatalogRepository["resolve"]>[0];

/** The named Channels as catalog rows the reader may see. */
export async function resolveChannelCatalog(env: SpacesEnv, input: Omit<CatalogResolution, "requestId">,
  dependencies: SpacesDependencies = {}) {
  const { database, requestId } = spaces(env, dependencies);
  const resolved = await new PostgresChannelCatalogRepository(database)
    .resolve({ requestId, ...input });
  const channels = resolved.channels as Record<string, unknown>[];
  await projectQuota(env, dependencies, requestId, channels);
  return { ...resolved, channels: channels.map(withChannelHeadPreview) };
}

export function getChannelCatalogRevision(env: SpacesEnv, input: { spaceId: string; principal: Principal }) {
  const { repository, requestId } = spaces(env);
  return repository.getChannelCatalogRevision({ requestId, ...input });
}

// Membership

export function createSpaceInvite(env: SpacesEnv, input: {
  commandId: string; spaceId: string; actorUserId: string; role: "admin" | "member" | "viewer"; admin: boolean;
  expiresInHours?: number; maxUses: number | null; requiresApproval: boolean;
}) {
  const { repository, requestId } = spaces(env, {}, input.commandId);
  return repository.createSpaceInvite({ requestId, ...input });
}

interface MemberProfile { email?: string; name?: string; avatarUrl?: string }

export async function acceptSpaceInvite(env: SpacesEnv, input: MemberProfile & {
  commandId: string; tokenHash: string; actorUserId: string;
}) {
  const { repository, requestId } = spaces(env, {}, input.commandId);
  const result = await repository.acceptSpaceInvite({ requestId, ...input });
  const joined = result.space && typeof result.space === "object" ? result.space as Record<string, unknown> : undefined;
  if (typeof joined?.id === "string") await publishCatalogChanges(env, {}, repository, requestId, [joined.id]);
  return result;
}

export async function joinOpenSpace(env: SpacesEnv, input: MemberProfile & {
  commandId: string; spaceId: string; actorUserId: string;
}) {
  const { repository, requestId } = spaces(env, {}, input.commandId);
  const result = await repository.joinOpenSpace({ requestId, ...input });
  if (result.space && typeof result.space === "object") {
    await publishCatalogChanges(env, {}, repository, requestId, [input.spaceId]);
  }
  return result;
}

export async function decideSpaceJoinRequest(env: SpacesEnv, input: {
  commandId: string; joinRequestId: string; actorUserId: string; approve: boolean;
}) {
  const { repository, requestId } = spaces(env, {}, input.commandId);
  const result = await repository.decideSpaceJoinRequest({ requestId, ...input });
  if (result.status === "approved" && typeof result.spaceId === "string") {
    await publishCatalogChanges(env, {}, repository, requestId, [result.spaceId]);
  }
  return result;
}

export function getSpaceInvite(env: SpacesEnv, tokenHash: string) {
  const { repository, requestId } = spaces(env);
  return repository.getSpaceInvite({ requestId, tokenHash });
}

export function listSpaceJoinRequests(env: SpacesEnv, input: {
  spaceId: string; actorUserId: string; cursor?: string; limit?: number;
}) {
  const { repository, requestId } = spaces(env);
  return repository.listSpaceJoinRequests({ requestId, ...input });
}

export function updateSpaceMemberCreationPolicy(env: SpacesEnv, input: DomainCommand & {
  spaceId: string; agentCreation?: "members" | "admins"; automationCreation?: "members" | "admins";
}) {
  const { repository, requestId } = spaces(env, {}, input.commandId);
  return repository.updateSpaceMemberCreationPolicy({ requestId, ...input });
}

type MembershipChange = PostgresMembershipMutation extends infer M
  ? M extends PostgresMembershipMutation ? Omit<M, "requestId"> : never : never;

/**
 * Puts or removes a Space member or a Channel access grant. Membership and
 * access decide what running executions may do, so the Space's Channels
 * recheck them.
 */
export async function changeMembership(env: SpacesEnv, change: MembershipChange,
  dependencies: SpacesDependencies = {}) {
  const { repository, requestId, database } = spaces(env, dependencies, change.commandId);
  const mutation = { ...change, requestId } as PostgresMembershipMutation;
  const spaceId = "spaceId" in mutation
    ? mutation.spaceId
    : await repository.resolveChannelSpaceId({ requestId, channelId: mutation.channelId });
  const result = await repository.mutateMembership(mutation);
  await publishCatalogChanges(env, dependencies, repository, requestId, [spaceId]);
  await wakeAffectedChannels(env, dependencies, database, spaceId);
  return result;
}

/** Immutable metadata history is visible only to the Channel's current readers. */
export async function channelMetadataHistory(env: SpacesEnv, input: {
  channelId: string; principal: Principal; beforeRevision?: number; revision?: number; inputId?: string; limit?: number;
}) {
  const { repository, requestId } = spaces(env);
  const spaceId = await repository.resolveChannelSpaceId({ requestId, channelId: input.channelId });
  return repository.metadataHistory({ requestId, spaceId, ...input });
}
