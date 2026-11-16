import { immutableContentObjectKey, lowercaseHex, restrictedChannelContentScope, sha256Hex } from "@xmatrix/protocol";
import { ContentControlError, type PostgresContentRepository } from "@xmatrix/db";
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

/**
 * Server-authored immutable bytes; only the named Human may read their scope.
 * Each write is its own pair of commands: the intent's expiry and the commit's
 * verification time differ on every attempt, so a later write of the same
 * record reusing the earlier command ids was refused as a reused command, for
 * good (a Gmail notification stuck on one message for days). The record's
 * refId keeps it one record: committing an existing one returns it.
 */
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
  // Short enough that a connector result's intent id stays within the upload gateway's 160 characters.
  const attempt = lowercaseHex(crypto.getRandomValues(new Uint8Array(6)));
  const now = Date.now(), intentId = `intent:${input.refId}:${attempt}`;
  const step = async (stage: "intent" | "upload" | "commit", action: () => Promise<unknown>) => {
    try { await retryRestrictedRecordStep(action); }
    catch { throw new RestrictedRecordWriteFailure(stage); }
  };
  await step("intent", () => input.content.createIntent({
    requestId: input.refId, commandId: `create:${input.refId}:${attempt}`, intentId, scopeId, purpose: input.kind,
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
  const commit = { requestId: input.refId, commandId: `commit:${input.refId}:${attempt}`, intentId, expectedIntentVersion: 1,
    refId: input.refId, ownerKind: input.kind, ownerId: input.ownerId, scopeId, objectKey, checksum,
    encodedBytes: bytes.byteLength, verifiedAt: new Date().toISOString(), principal };
  await step("commit", async () => {
    try { await input.content.commitRef(commit); }
    catch (error) {
      // A connector result already saved for its message stands: the notification was posted beside it.
      if (input.kind === "connector_result" && error instanceof ContentControlError && error.code === "blob_ref_conflict") return;
      throw error;
    }
  });
}
