import { sha256Hex } from "@xmatrix/protocol";
import { relayContentRepository } from "../relay-r2-upload-private-api";
import { retryRestrictedRecordStep, writeRestrictedRecord } from "../restricted-record-content";
import { ProviderRequestError } from "./http";
import type { Env } from "../types";

export const MAX_PRIVATE_CONNECTOR_RECORD_BYTES = 272 * 1024;

/** The Human owner is frozen from the authenticated Run, never Channel metadata. */
export async function writeConnectorPrivateResult(env: Env, input: {
  channelId: string; spaceId: string; ownerUserId: string; messageId: string; detail: string;
}): Promise<void> {
  if (!env.RELAY_PAYLOAD_BUCKET || !env.RELAY_SUMMON_DECISION_CLOCK) {
    throw new ProviderRequestError(503, "Private result storage is unavailable");
  }
  const clock = env.RELAY_SUMMON_DECISION_CLOCK.get(env.RELAY_SUMMON_DECISION_CLOCK.idFromName(input.spaceId)) as unknown as {
    arm(spaceId: string): Promise<void>;
  };
  try {
    await retryRestrictedRecordStep(() => clock.arm(input.spaceId));
    await writeRestrictedRecord({ content: relayContentRepository(env), bucket: env.RELAY_PAYLOAD_BUCKET,
      actorUserId: input.ownerUserId, channelId: input.channelId, refId: `connector-result:${input.messageId}`,
      ownerId: input.messageId, kind: "connector_result", payload: { version: 1, detail: input.detail },
      maximumBytes: MAX_PRIVATE_CONNECTOR_RECORD_BYTES });
    await retryRestrictedRecordStep(() => clock.arm(input.spaceId));
  } catch {
    // Neither stored values nor storage exceptions may become public failure details.
    throw new ProviderRequestError(503, "The private result could not be saved");
  }
}

/** A dedicated Human read, reauthorized after immutable bytes arrive from R2. */
export async function readConnectorPrivateResult(env: Env, input: {
  channelId: string; messageId: string; ownerUserId: string;
}): Promise<{ detail: string }> {
  if (!env.RELAY_PAYLOAD_BUCKET) throw new ProviderRequestError(503, "Private result storage is unavailable");
  const content = relayContentRepository(env);
  const read = () => content.connectorResultRef({ requestId: crypto.randomUUID(), channelId: input.channelId,
    messageId: input.messageId, principal: { kind: "user", id: input.ownerUserId } });
  const ref = await read();
  if (!Number.isSafeInteger(ref.encodedBytes) || Number(ref.encodedBytes) > MAX_PRIVATE_CONNECTOR_RECORD_BYTES) {
    throw new ProviderRequestError(502, "Private result is invalid");
  }
  const object = await env.RELAY_PAYLOAD_BUCKET.get(String(ref.objectKey));
  if (!object || object.size !== ref.encodedBytes) throw new ProviderRequestError(503, "Private result is unavailable");
  const bytes = await object.arrayBuffer();
  if (await sha256Hex(new Uint8Array(bytes)) !== ref.checksum) throw new ProviderRequestError(502, "Private result verification failed");
  let record: unknown;
  try { record = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* Fail without parser snippets. */ }
  if (!record || typeof record !== "object" || (record as { version?: unknown }).version !== 1 ||
      typeof (record as { detail?: unknown }).detail !== "string") throw new ProviderRequestError(502, "Private result is invalid");
  await read();
  return { detail: (record as { detail: string }).detail };
}
