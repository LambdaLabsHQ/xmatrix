import type { DatabaseTransaction } from "./contracts.js";
import { storedObject as object } from "./stored-values.js";

/** Compatibility with daemons that replaced the original pool binding on
 * handoff. New daemons retain it. Only the exact same directory's durable
 * successor may witness the legacy recovery; names and presence are irrelevant. */
export async function handoffResumeSource(tx: DatabaseTransaction, source: {
  handoffSuccessorInstanceId?: string; key: { ownerUserId: string; machineId: string };
  canonicalCwd?: string; managedWorkspaceKey?: string; remoteRepo?: string;
  repoPool?: { repoIdentity: string; repoKeyId: string; slotId: string };
}, channelId: string) {
  let instanceId = source.handoffSuccessorInstanceId;
  const seen = new Set<string>();
  for (let depth = 0; instanceId && depth < 16 && !seen.has(instanceId); depth++) {
    seen.add(instanceId);
    const row = (await tx.query({ name: "handoff_resume_source_v1", text: `SELECT r.run_id,r.metadata_json
      FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id AND r.channel_id=i.channel_id
      WHERE i.instance_id=$1 AND i.channel_id=$2 AND r.owner_user_id=$3
        AND r.metadata_json->>'machineId'=$4 AND r.workspace_canonical_cwd IS NOT DISTINCT FROM $5`,
    values: [instanceId, channelId, source.key.ownerUserId, source.key.machineId, source.canonicalCwd ?? null], maxRows: 1 }))[0];
    if (!row) return undefined;
    const metadata = object(row.metadata_json);
    if (metadata.instanceDeletion !== undefined || metadata.managedWorkspaceKey !== source.managedWorkspaceKey ||
        metadata.remoteRepo !== source.remoteRepo || ["repoIdentity", "repoKeyId", "slotId"].some(
          key => object(metadata.repoPool)[key] !== object(source.repoPool)[key])) return undefined;
    if (metadata.instanceHandoff === undefined) {
      return typeof metadata.resumeSessionKey === "string" ? {
        handoffSourceInstanceId: instanceId, handoffSourceResumeSessionKey: metadata.resumeSessionKey,
      } : undefined;
    }
    const transfer = object(metadata.instanceHandoff);
    if (transfer.schemaVersion !== 1 || transfer.instanceId !== instanceId || transfer.runId !== row.run_id ||
        typeof transfer.successorInstanceId !== "string") return undefined;
    instanceId = transfer.successorInstanceId;
  }
  return undefined;
}
