import { hasControlCharacter, type SerializedMachineDaemon } from "@xmatrix/protocol";
import type { Env } from "./types";
import { readBoundedRequestBody } from "./index-shared";
import { listOwnerMachineDaemons, machineDaemonCommand, machineRepository } from "./machines";

/** Owner-requested Machine actions (harnesses, worktrees) share their request and delivery handling. */
export const NO_STORE = { "cache-control": "private, no-store" };

export function isMachineField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= 160 && !hasControlCharacter(value);
}

export function refuse(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

export interface MachineActionDelivery {
  daemons(env: Env, ownerUserId: string): Promise<SerializedMachineDaemon[]>;
  issue(env: Env, command: Record<string, unknown>): Promise<unknown>;
}

export const MACHINE_ACTION_DELIVERY: MachineActionDelivery = {
  daemons: async (env, ownerUserId) =>
    await listOwnerMachineDaemons(machineRepository(env), ownerUserId) as unknown as SerializedMachineDaemon[],
  issue: machineDaemonCommand,
};

/** The request's JSON object, or the refusal for a body that is too large or not JSON. */
export async function readActionBody(request: Request, maxBytes: number, noun: string):
  Promise<Record<string, unknown> | Response> {
  const bytes = await readBoundedRequestBody(request, maxBytes);
  if (!bytes) return refuse(`${noun} request too large`, 413);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch {
    return refuse(`Invalid ${noun.toLowerCase()} request`, 400);
  }
}

/**
 * Issue one command to the Machine's single online daemon. A hostname never
 * disambiguates Machine identity: two online daemons are a conflict.
 */
export async function issueToOnlineDaemon(port: MachineActionDelivery, env: Env, input: {
  ownerUserId: string; machineId: string; requestId: string; commandType: string; payload: Record<string, unknown>;
}): Promise<Response | undefined> {
  const daemons = await port.daemons(env, input.ownerUserId);
  const online = daemons.filter(daemon => daemon.machineId === input.machineId && daemon.status === "online");
  if (online.length !== 1) {
    return refuse(online.length ? "The Machine has conflicting active daemons" : "The Machine is offline", 409);
  }
  const daemon = online[0]!;
  await port.issue(env, {
    ownerUserId: input.ownerUserId, ownerEmail: daemon.email, machineId: input.machineId, hostId: daemon.hostId,
    daemonId: daemon.id, commandId: `issue:${input.requestId}`, action: "issue", controlId: input.requestId,
    commandType: input.commandType, principal: { kind: "user", id: input.ownerUserId }, payload: input.payload,
  });
  return undefined;
}
