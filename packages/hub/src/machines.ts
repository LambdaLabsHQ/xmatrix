import {
  MachineControlError,
  PostgresMachineControlRepository,
  retireMachine,
  type AuthorityDatabase,
} from "@xmatrix/db";
import { stableMachineDaemonId } from "@xmatrix/protocol";

import {
  postgresAuthorityDatabase,
  postgresRequestText,
  type PostgresAuthorityBindingEnv,
} from "./postgres-authority-http";
import { relayRuntimeCellsForOwners } from "./relay-authority-locator";
import {
  machineDaemonWakeFanOut,
  wakeCommittedPostgresMachineDaemonIssue,
  type MachineDaemonWakeResult,
} from "./relay-authority-machine-daemon-wake";
import { machineDaemonReachable } from "./runtime-transport/machine-daemon-deliverable";
import { wakeRegistrationChannels } from "./registration-authority-wake";

export interface MachineCommandEnv extends PostgresAuthorityBindingEnv {
  MACHINE_NAME_REQUIRED?: string;
  XMATRIX_RUNTIME_LOCATION_HINT?: string;
  RELAY_RUNTIME?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

/** Machines, their daemons and the commands sent to them live on the directory shard. */
export function machineDatabase(env: PostgresAuthorityBindingEnv, database?: AuthorityDatabase): AuthorityDatabase {
  return postgresAuthorityDatabase(env, "Machine", "xmatrix-hub-machine-control", database);
}

export function machineRepository(env: PostgresAuthorityBindingEnv, database?: AuthorityDatabase) {
  return new PostgresMachineControlRepository(machineDatabase(env, database));
}

/**
 * Retires the owner's Machine, then wakes every Channel with a registration on
 * it: retirement disables those registrations and each Channel's coordinator
 * stops its Runs through the daemon, which stays connected until its next
 * credential refresh is refused. A failed wake fails the request, and its retry
 * wakes the same Channels again.
 */
export async function retireOwnerMachine(
  env: Parameters<typeof wakeRegistrationChannels>[0],
  database: AuthorityDatabase,
  scope: { ownerUserId: string; machineId: string },
  wake: typeof wakeRegistrationChannels = wakeRegistrationChannels,
) {
  const retired = await retireMachine(database, { requestId: crypto.randomUUID(), ...scope });
  return { ...retired, stoppingChannels: await wake(env, database, scope) };
}

/** Every daemon the owner runs, following the cursor. */
export async function listOwnerMachineDaemons(
  repository: PostgresMachineControlRepository,
  ownerUserId: string,
): Promise<Record<string, unknown>[]> {
  const daemons: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list({ requestId: crypto.randomUUID(), ownerUserId, cursor, limit: 200 });
    daemons.push(...page.daemons);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return daemons;
}

type Fields = Record<string, unknown>;

/** What a command must have been issued as for its status to be read back under its control id. */
export const MACHINE_COMMAND_EXPECTATIONS = {
  spawn: (controlId: string, input: Fields) => ({
    type: "machine_spawn_agent", requestId: controlId,
    runId: input.runId, executionKey: input.executionKey, instanceId: input.instanceId,
    ...(typeof input.launchId === "string" ? { launchId: input.launchId } : {}),
  }),
  stop: (controlId: string, input: Fields) => ({
    type: "machine_stop_agent", requestId: controlId, runId: input.runId,
    executionKey: input.executionKey, agentId: input.agentId, instanceId: input.instanceId,
    resumeSessionKey: input.resumeSessionKey, worktreeDisposition: input.worktreeDisposition,
    repoIdentity: input.repoIdentity, repoKeyId: input.repoKeyId, slotId: input.slotId,
  }),
  /* A reborn stop keeps the Instance; a handoff stop retires it and carries no such field. */
  rebornStop: (controlId: string, input: Fields) => ({
    type: "machine_stop_agent", requestId: controlId,
    runId: input.runId, instanceId: input.instanceId,
    preserveInstanceForReborn: input.preserveInstanceForReborn === false ? undefined : true,
  }),
  recoverReply: (controlId: string, input: Fields) => ({
    type: "machine_recover_reply", requestId: controlId, runId: input.runId, instanceId: input.instanceId,
    executionKey: input.executionKey, channelId: input.channelId, executionId: input.executionId,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
  }),
} as const;

const COMMAND_TYPES = { spawn: "spawn", stop: "stop", rebornStop: "stop", recoverReply: "recover_reply" } as const;

/** The status of one command the owner issued, checked against what it was issued as. */
export function machineCommandStatus(
  repository: PostgresMachineControlRepository,
  kind: keyof typeof MACHINE_COMMAND_EXPECTATIONS,
  input: Fields & { ownerUserId: string; controlId: string; machineId?: string; hostId?: string },
) {
  return repository.status({
    requestId: crypto.randomUUID(), ownerUserId: input.ownerUserId, controlId: input.controlId,
    ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
    ...(input.hostId !== undefined ? { hostId: input.hostId } : {}),
    commandType: COMMAND_TYPES[kind], expected: MACHINE_COMMAND_EXPECTATIONS[kind](input.controlId, input),
  });
}

function commandText(value: unknown, field: string, maximumBytes: number): string {
  return postgresRequestText(value, () => new MachineControlError(
    "invalid_machine_command", 400, `${field} is invalid`), maximumBytes);
}

export type MachineIssueWake = (
  input: Record<string, unknown>,
  result: Record<string, unknown>,
) => Promise<MachineDaemonWakeResult | undefined>;

/** Wakes the owner's daemon sockets for an issued command, wherever their Runtime cells are. */
function runtimeIssueWake(env: MachineCommandEnv): MachineIssueWake | undefined {
  const runtime = env.RELAY_RUNTIME;
  if (!runtime) return undefined;
  return (input, result) => wakeCommittedPostgresMachineDaemonIssue(
    (ownerUserId) => machineDaemonWakeFanOut(relayRuntimeCellsForOwners({
      RELAY_RUNTIME: runtime, XMATRIX_RUNTIME_LOCATION_HINT: env.XMATRIX_RUNTIME_LOCATION_HINT,
    }, [ownerUserId])), input, result);
}

/**
 * Applies one daemon control command — enroll, connect, issue, claim, renew,
 * complete and the rest — to the owner's Machine. An issued command wakes the
 * owner's daemon; one no daemon could receive is recorded as failed delivery
 * and the daemon reads as offline.
 */
export async function machineDaemonCommand(
  env: MachineCommandEnv,
  input: Record<string, unknown>,
  dependencies: { database?: AuthorityDatabase; wake?: MachineIssueWake } = {},
): Promise<Record<string, unknown>> {
  const repository = machineRepository(env, dependencies.database);
  const ownerUserId = commandText(input.ownerUserId, "ownerUserId", 200);
  const machineId = commandText(input.machineId, "machineId", 160);
  const observation = input.hostname ?? input.hostId;
  const hostId = observation === undefined || observation === "" ? "" : commandText(observation, "hostname", 160);
  const current = !hostId && !input.daemonId
    ? await repository.getDaemon({ requestId: crypto.randomUUID(), ownerUserId, machineId, hostId: "" }) : null;
  let value = await repository.command({ ...input, requireMachineName: env.MACHINE_NAME_REQUIRED === "true",
    daemonId: typeof input.daemonId === "string" && input.daemonId.trim()
      ? input.daemonId.trim() : current?.daemon?.id ?? stableMachineDaemonId(ownerUserId, machineId, hostId) });
  if (input.action !== "issue" && input.action !== "issue_batch") return value;
  const wake = dependencies.wake ?? runtimeIssueWake(env);
  const woken = wake ? await wake(input, value) : undefined;
  if (!woken) return value;
  value = { ...value, delivered: woken.delivered, owners: woken.owners, deliverable: woken.deliverable };
  if (machineDaemonReachable(woken)) return value;
  try {
    await repository.command({
      ...input,
      commandId: `${String(input.commandId || "machine-issue")}:failed-deliver`.slice(0, 200),
      action: "failed-deliver",
      payload: {},
    });
    if (value.daemon && typeof value.daemon === "object" && !Array.isArray(value.daemon)) {
      value.daemon = { ...value.daemon, status: "offline" };
    }
  } catch (error) {
    console.warn("Machine Daemon failed deliver could not project offline", {
      commandId: input.commandId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return value;
}
