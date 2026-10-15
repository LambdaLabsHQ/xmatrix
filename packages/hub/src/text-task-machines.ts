import { PostgresMachineControlRepository } from "@xmatrix/db";
import { MACHINE_TEXT_TASK_CAPABILITY, TEXT_TASK_HARNESSES } from "@xmatrix/protocol";
import { registrationQuotaProbeTargetReader } from "./agent-routing-quota-refresh";
import { machineDaemonCommand, machineDatabase } from "./machines";
import { createPostgresAuthorityDatabase, createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "./postgres-authority-http";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "./postgres-message-database-policy";
import type { Env } from "./types";

/**
 * A Machine that can answer one text task now: one of the Space's enabled Agents' harnesses on it,
 * with its daemon online and able to take the task. A task's text is disclosed to that Machine's
 * owner's environment, so whoever issues one reads the text as that owner first.
 */
export interface TextTaskMachine {
  ownerUserId: string;
  machineId: string;
  hostId: string;
  harness: string;
  daemon: { id: string; email: string };
}

/** The Space's Machines that can take a text task now, in a stable order, each looked up as it is reached. */
export async function* textTaskMachines(env: Env, spaceId: string, purpose: string): AsyncGenerator<TextTaskMachine> {
  const applicationName = `xmatrix-${purpose}-targets`;
  const database = createPostgresAuthorityDatabase(env, { applicationName,
    connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS, statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000,
    lockTimeoutMs: 2_000 });
  const directory = createPostgresAuthorityFleet(env, { applicationName, ...POSTGRES_AUTHORITY_TIMEOUTS }).directoryDatabase;
  const targets = (await registrationQuotaProbeTargetReader(database, directory)(spaceId))
    .filter((target) => TEXT_TASK_HARNESSES.includes(target.harness));
  const machines = new PostgresMachineControlRepository(machineDatabase(env));
  for (const target of targets) {
    const route = { ownerUserId: target.ownerUserId, machineId: target.machineId, hostId: target.hostId };
    const { daemon } = await machines.getDaemon({ requestId: crypto.randomUUID(), ...route });
    if (!daemon || daemon.status !== "online" || !daemon.capabilities.includes(MACHINE_TEXT_TASK_CAPABILITY)) continue;
    yield { ...route, harness: target.harness, daemon: { id: daemon.id, email: daemon.email } };
  }
}

/** Hands one text task to a Machine's daemon, for its harness to answer once. */
export async function issueTextTask(env: Env, machine: TextTaskMachine,
  task: { requestId: string; instruction: string; input: string }): Promise<void> {
  await machineDaemonCommand(env, {
    ownerUserId: machine.ownerUserId, machineId: machine.machineId, hostId: machine.hostId,
    ownerEmail: machine.daemon.email, daemonId: machine.daemon.id,
    commandId: `issue:${task.requestId}`, action: "issue", controlId: task.requestId, commandType: "text_task",
    principal: { kind: "user", id: machine.ownerUserId },
    payload: { type: "machine_text_task", requestId: task.requestId, presetId: machine.harness,
      instruction: task.instruction, input: task.input },
  });
}
