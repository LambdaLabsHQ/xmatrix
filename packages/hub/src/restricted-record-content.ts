import { immutableContentObjectKey, restrictedChannelContentScope, sha256Hex } from "@xmatrix/protocol";
import type { PostgresContentRepository } from "@xmatrix/db";
import { cloudflareRelayPrivateR2UploadPort } from "./relay-r2-upload-private-api";
import { executeRelayR2UploadGatewayRequest, RELAY_R2_UPLOAD_CHECKSUM_HEADER } from "./relay-r2-upload-gateway";

export class RestrictedRecordWriteFailure extends Error {
  constructor(readonly stage: "intent" | "upload" | "commit" | "oversize") {
    super("Private record could not be saved");
  }
}

/** Retry exactly the same authority command, without logging its private context. */
export async function retryRestrictedRecordStep<T>(step: () => Promise<T>): Promise<T> {
  try { return await step(); }
  catch { await new Promise(resolve => setTimeout(resolve, 100)); return step(); }
}

/** Server-authored immutable bytes; only the named Human may read their scope. */
export async function writeRestrictedRecord(input: {
  content: Pick<PostgresContentRepository, "createIntent" | "commitRef">; bucket: R2Bucket;
  actorUserId: string; channelId: string; refId: string; ownerId: string;
  kind: "summon_decision" | "connector_result"; payload: unknown; maximumBytes: number;
}): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(input.payload));
  if (bytes.byteLength > input.maximumBytes) throw new RestrictedRecordWriteFailure("oversize");
  const scopeId = restrictedChannelContentScope(input.channelId, input.actorUserId);
  const principal = { kind: "user" as const, id: input.actorUserId };
  const checksum = await sha256Hex(bytes), objectKey = immutableContentObjectKey(scopeId, checksum);
  const now = Date.now(), intentId = `intent:${input.refId}`;
  const step = async (stage: "intent" | "upload" | "commit", action: () => Promise<unknown>) => {
    try { await retryRestrictedRecordStep(action); }
    catch { throw new RestrictedRecordWriteFailure(stage); }
  };
  await step("intent", () => input.content.createIntent({
    requestId: input.refId, commandId: `create:${input.refId}`, intentId, scopeId, purpose: input.kind,
    contentHash: checksum, encodedBytes: bytes.byteLength, expiresAt: new Date(now + 15 * 60_000).toISOString(), principal,
  }));
  await step("upload", () => executeRelayR2UploadGatewayRequest({
    request: new Request("https://internal/api/relay-v2/private-r2/upload", { method: "PUT", body: bytes,
      headers: { "content-length": String(bytes.byteLength), [RELAY_R2_UPLOAD_CHECKSUM_HEADER]: checksum } }),
    now, visibilityScopeId: scopeId,
    intent: { intentId, visibilityScopeId: scopeId, contentHash: checksum, checksumSha256: checksum,
      encodedSize: bytes.byteLength, finalKey: objectKey, expiresAt: now + 15 * 60_000,
      state: "pending", allowStaging: false },
    bucket: cloudflareRelayPrivateR2UploadPort(input.bucket),
  }));
  const commit = { requestId: input.refId, commandId: `commit:${input.refId}`, intentId, expectedIntentVersion: 1,
    refId: input.refId, ownerKind: input.kind, ownerId: input.ownerId, scopeId, objectKey, checksum,
    encodedBytes: bytes.byteLength, verifiedAt: new Date().toISOString(), principal };
  await step("commit", () => input.content.commitRef(commit));
}
