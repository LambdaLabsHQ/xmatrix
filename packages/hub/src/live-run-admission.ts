import { plainRecord } from "@xmatrix/protocol";
/**
 * One admission gate for "is this proof still the live Authority Run?".
 *
 * Launch, token mint, Agent HTTP, and Runtime connect all asked the same
 * question with locally copied predicates. The public error string stays at
 * the call site; this module only names which field failed.
 */

export const LIVE_RUN_STATUSES = ["starting", "running"] as const;

export type LiveRunAdmissionField =
  | "agentId"
  | "channelId"
  | "executionKey"
  | "machineId"
  | "hostId"
  | "instanceId"
  | "status";

/** Identity a spawn command must keep proving until OS launch succeeds. */
export const LIVE_RUN_LAUNCH_FIELDS = [
  "agentId",
  "channelId",
  "executionKey",
  "status",
] as const satisfies readonly LiveRunAdmissionField[];

/** JWT / Agent HTTP revalidation also binds the exact machine route. */
export const LIVE_RUN_ROUTED_FIELDS = [
  ...LIVE_RUN_LAUNCH_FIELDS,
  "machineId",
] as const satisfies readonly LiveRunAdmissionField[];

/** Routed identity plus optional instance binding when the proof names one. */
export const LIVE_RUN_PRINCIPAL_FIELDS = [
  ...LIVE_RUN_ROUTED_FIELDS,
  "instanceId",
] as const satisfies readonly LiveRunAdmissionField[];

export type LiveRunSnapshot = {
  agentId: unknown;
  channelId: unknown;
  executionKey: unknown;
  status: unknown;
  machineId?: unknown;
  hostId?: unknown;
  instanceId?: unknown;
};

export type LiveRunProof = {
  agentId?: unknown;
  channelId?: unknown;
  executionKey?: unknown;
  machineId?: unknown;
  hostId?: unknown;
  instanceId?: unknown;
};

export const AGENT_RUN_TOKEN_CONTEXT_MISMATCH =
  "Agent run token context does not match the live Authority run";

function recordMetadata(value: unknown): Record<string, unknown> {
  return plainRecord(value) ?? {};
}

/** Snapshot a `get-run` / productGatewayRun payload. */
export function snapshotLiveRunFromProductGateway(run: Record<string, unknown>): LiveRunSnapshot {
  const metadata = recordMetadata(run.metadata);
  // A registered background session has no Channel Instance; its session id acts as one.
  const instanceId = run.instanceId ?? metadata.runtimeSessionId;
  return {
    // A Run acts as its Instance.
    agentId: instanceId,
    channelId: run.channelId,
    executionKey: metadata.executionKey,
    status: run.status,
    machineId: metadata.machineId,
    hostId: metadata.hostId,
    instanceId,
  };
}

export function isLiveRunStatus(status: unknown): boolean {
  return LIVE_RUN_STATUSES.includes(String(status) as (typeof LIVE_RUN_STATUSES)[number]);
}

export function liveRunAdmissionMismatches(
  snapshot: LiveRunSnapshot,
  proof: LiveRunProof,
  fields: readonly LiveRunAdmissionField[],
): string[] {
  const mismatches: string[] = [];
  for (const field of fields) {
    if (field === "status") {
      if (!isLiveRunStatus(snapshot.status)) {
        mismatches.push(`status=${String(snapshot.status ?? "") || "missing"}`);
      }
      continue;
    }
    if (field === "instanceId" && proof.instanceId === undefined) continue;
    if (snapshot[field] !== proof[field]) mismatches.push(field);
  }
  return mismatches;
}

export function liveRunIsAdmitted(
  snapshot: LiveRunSnapshot,
  proof: LiveRunProof,
  fields: readonly LiveRunAdmissionField[],
): boolean {
  return liveRunAdmissionMismatches(snapshot, proof, fields).length === 0;
}

export function formatLiveRunAdmissionMismatch(
  prefix: string,
  snapshot: LiveRunSnapshot,
  proof: LiveRunProof,
  fields: readonly LiveRunAdmissionField[],
): string | undefined {
  const mismatches = liveRunAdmissionMismatches(snapshot, proof, fields);
  if (mismatches.length === 0) return undefined;
  return `${prefix} (${mismatches.join(", ")})`;
}

/** Token mint: launch identity only. Machine route is a later daemon-principal check. */
/**
 * Delivery, lease, epoch, transient Hub/database availability and opaque
 * token-context failures are not proof the host cannot launch. Identity
 * mismatches and host startup errors are.
 */
export function isRecoverableLaunchFailure(detail: unknown): boolean {
  const text = String(detail ?? "").trim().toLowerCase();
  if (!text) return false;
  if (text.includes("does not match the live authority run")) {
    const hasIdentity = /(?:^|[\s,(])(?:agentid|channelid|executionkey)(?:$|[\s,)])/u.test(text);
    return !hasIdentity;
  }
  return text.includes("connection epoch") ||
    text.includes("allocation_daemon_reconnected") ||
    // The Hub or its database was briefly unavailable before anything started.
    /\bstatus 50[234]\b/u.test(text) ||
    text.includes("authority is unavailable") ||
    text.includes("postgresql is unavailable") ||
    text.includes("error reading a body from connection") ||
    text.includes("lease renewal") ||
    (text.includes("lease") && text.includes("stale")) ||
    text.includes("command lease") ||
    text.includes("control connection is offline") ||
    text.includes("control connection is closed") ||
    text.includes("relaytransient");
}

export function agentRunTokenContextMismatch(input: {
  run: Record<string, unknown>;
  body: {
    executionKey?: string;
    agentId?: string;
    channelId?: string;
  };
}): string | undefined {
  return formatLiveRunAdmissionMismatch(
    AGENT_RUN_TOKEN_CONTEXT_MISMATCH,
    snapshotLiveRunFromProductGateway(input.run),
    {
      agentId: input.body.agentId,
      channelId: input.body.channelId,
      executionKey: input.body.executionKey,
    },
    LIVE_RUN_LAUNCH_FIELDS,
  );
}
