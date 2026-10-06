import { PostgresAgentRegistrationRepository, PostgresRegistrationAccessRepository, PostgresAgentEnvironmentRepository,
  PostgresSpacePlacementDirectory, RegistrationAccessError, changeSpaceState,
  readRegistrationQuotaProbeTargets,
  type AuthorityDatabase } from "@xmatrix/db";
import type { parseAgentEnvironmentCommand, parseAgentRegistrationCommand, parseAgentRegistrationKey,
  parseSpaceAgentRegistrationKey } from "@xmatrix/protocol";
import { createPostgresAuthorityDatabase, createPostgresAuthorityFleet, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";
import { issueRegistrationQuotaProbes, type QuotaProbeIssueDependencies } from "./agent-routing-quota-refresh";
import type { Env } from "./types";
import { wakeRegistrationChannels } from "./registration-authority-wake";

type RegistrationCommand = ReturnType<typeof parseAgentRegistrationCommand>;
type RegistrationKey = ReturnType<typeof parseSpaceAgentRegistrationKey>;
type EnvironmentCommand = ReturnType<typeof parseAgentEnvironmentCommand>;
type EnvironmentKey = ReturnType<typeof parseAgentRegistrationKey>;

export interface RegistrationEnv extends PostgresAuthorityFleetEnv {
  RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL?: DurableObjectNamespace;
}

/** How often one daemon is asked for its quota on behalf of Agents page readers. */
const REGISTRATION_QUOTA_REFRESH_INTERVAL_MS = 60_000;

const TIMEOUTS = { statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000 } as const;

interface RegistrationDatabases { database?: AuthorityDatabase; directoryDatabase?: AuthorityDatabase }

/** One request session on a Space's active placement, closed when the work is done. */
async function withPlacedRegistrations<T>(env: RegistrationEnv, spaceId: string, requestId: string,
  databases: RegistrationDatabases,
  work: (session: AuthorityDatabase, placement: Awaited<ReturnType<PostgresSpacePlacementDirectory["resolve"]>>,
    directory: () => AuthorityDatabase) => Promise<T>): Promise<T> {
  const fleet = databases.database ? undefined : createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-registration", ...TIMEOUTS });
  const session = (databases.database ?? fleet!.database).openSession();
  try {
    const placement = await new PostgresSpacePlacementDirectory(session).resolve({
      requestId, operation: "registration.placement" }, spaceId);
    if (placement.state !== "active") throw new RegistrationAccessError("registration_placement_unavailable", 503);
    return await work(session, placement,
      () => databases.directoryDatabase ?? databases.database ?? fleet!.directoryDatabase);
  } finally { await session.close(); }
}

/** One page of the Space's Agent registrations a member may see. */
export function listAgentRegistrations(env: RegistrationEnv, input: {
  actorUserId: string; spaceId: string; cursor?: string | null; limit?: number;
}, databases: RegistrationDatabases = {}) {
  const requestId = crypto.randomUUID();
  return withPlacedRegistrations(env, input.spaceId, requestId, databases, async (session, placement) => {
    const page = await new PostgresAgentRegistrationRepository(session, placement).list({ ...input, requestId });
    return { registrations: page.registrations, cursor: page.nextCursor };
  });
}

/**
 * Asks the daemons behind a Space's registrations to read their quota again.
 * Readers watching the Agents page share one reading per daemon a minute;
 * the daemon's completed probe writes it where the catalog reads it.
 */
export function refreshAgentRegistrationQuota(env: RegistrationEnv, input: { actorUserId: string; spaceId: string },
  databases: RegistrationDatabases & { quotaProbes?: QuotaProbeIssueDependencies } = {}) {
  const requestId = crypto.randomUUID();
  return withPlacedRegistrations(env, input.spaceId, requestId, databases, async (session, placement, directory) => {
    await new PostgresAgentRegistrationRepository(session, placement).requireReader({ ...input, requestId });
    const entries = await readRegistrationQuotaProbeTargets({ database: session, directory: directory(), requestId,
      placement: { spaceId: placement.spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
      probedWithinMs: REGISTRATION_QUOTA_REFRESH_INTERVAL_MS });
    return issueRegistrationQuotaProbes({ env: env as unknown as Env, directory: directory(), entries },
      databases.quotaProbes);
  });
}

/** One registration of the Space, as the reader may see it. */
export function getAgentRegistration(env: RegistrationEnv, input: { actorUserId: string; key: RegistrationKey },
  databases: RegistrationDatabases = {}) {
  const requestId = crypto.randomUUID();
  return withPlacedRegistrations(env, input.key.spaceId, requestId, databases, (session, placement) =>
    new PostgresAgentRegistrationRepository(session, placement).get({ ...input, requestId }));
}

/**
 * Offers, creates, configures or grants a Space's registration, or changes the
 * Space's registration state. A change that can withdraw what running
 * executions may do wakes the Space's Channels to recheck them.
 */
export function controlAgentRegistration(env: RegistrationEnv, input: {
  actorUserId: string; command: RegistrationCommand; byAgent?: boolean;
}, databases: RegistrationDatabases = {}) {
  const { actorUserId, command } = input;
  const spaceId = command.key.spaceId;
  return withPlacedRegistrations(env, spaceId, command.commandId, databases, async (session, placement) => {
    const repository = new PostgresAgentRegistrationRepository(session, placement);
    if (command.action === "offer") return repository.offer({ ...command, actorUserId });
    if (command.action === "configure") return repository.configure({ ...command, actorUserId });
    let result: unknown;
    if (command.action === "create") {
      result = await repository.create({ ...command, actorUserId, byAgent: input.byAgent === true });
    } else if (command.action === "space-state") {
      const { action: _action, ...state } = command;
      result = await changeSpaceState(session, placement, { ...state, actorUserId });
    } else {
      const { action: _action, ...grant } = command;
      result = await new PostgresRegistrationAccessRepository(session, placement).change({ ...grant, actorUserId });
    }
    await wakeRegistrationChannels(env, session, { spaceId });
    return result;
  });
}

/** One open session on the Machine environment shard, closed when the work is done. */
async function withEnvironments<T>(env: RegistrationEnv, database: AuthorityDatabase | undefined,
  work: (session: AuthorityDatabase) => Promise<T>): Promise<T> {
  const session = (database ?? createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-environment", ...TIMEOUTS })).openSession();
  try { return await work(session); } finally { await session.close(); }
}

/** A Machine owner's harness environment. */
export function getAgentEnvironment(env: RegistrationEnv, input: { actorUserId: string; key: EnvironmentKey },
  database?: AuthorityDatabase) {
  return withEnvironments(env, database, session => new PostgresAgentEnvironmentRepository(session)
    .get({ ...input, requestId: crypto.randomUUID() }));
}

/** Changes a Machine owner's harness environment; running executions on that Machine are rechecked. */
export function changeAgentEnvironment(env: RegistrationEnv, input: { actorUserId: string; command: EnvironmentCommand },
  database?: AuthorityDatabase) {
  return withEnvironments(env, database, async session => {
    const result = await new PostgresAgentEnvironmentRepository(session).change({ ...input.command,
      actorUserId: input.actorUserId });
    await wakeRegistrationChannels(env, session,
      { ownerUserId: input.command.key.ownerUserId, machineId: input.command.key.machineId });
    return result;
  });
}
