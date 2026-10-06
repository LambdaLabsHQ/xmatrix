import {
  ContentControlError,
  PostgresContentRepository,
  type AuthorityDatabase,
} from "@xmatrix/db";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import {
  POSTGRES_AUTHORITY_TIMEOUTS,
  postgresAuthorityShardId,
  postgresRequestObject,
  postgresRequestText,
} from "./postgres-authority-http";

interface ContentEnv {
  RELAY_POSTGRES?: { connectionString: string };
  RELAY_POSTGRES_SHARD_ID?: string;
}

function record(value: unknown, field = "request"): Record<string, unknown> {
  return postgresRequestObject(value, () => new ContentControlError(
    "invalid_command", 400, `${field} is invalid`));
}

function text(value: unknown, field: string): string {
  return postgresRequestText(value, () => new ContentControlError("invalid_command", 400, `${field} is invalid`));
}

/** Seal a message's uploaded attachments to it, answering their receipts; a rejection throws ContentControlError. */
export async function sealMessageAttachments(
  env: ContentEnv,
  input: Record<string, unknown>,
  dependencies: { database?: AuthorityDatabase } = {},
): Promise<Record<string, unknown>[]> {
  const shardId = postgresAuthorityShardId(env, "content");
  const database = dependencies.database ?? createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-content", ...POSTGRES_AUTHORITY_TIMEOUTS,
  });
  const repository = new PostgresContentRepository(database, shardId);
  const requestId = typeof input.commandId === "string" && input.commandId.trim()
    ? input.commandId.trim() : crypto.randomUUID();
  if (!Array.isArray(input.attachments)) throw new ContentControlError(
    "invalid_command", 400, "attachments are invalid",
  );
  return repository.sealAttachments({
    requestId, channelId: text(input.channelId, "channelId"),
    messageId: text(input.messageId, "messageId"), actorUserId: text(input.actorUserId, "actorUserId"),
    attachments: input.attachments.map((value) => {
      const attachment = record(value, "attachment");
      return { attachmentId: text(attachment.attachmentId, "attachmentId"),
        objectKey: text(attachment.objectKey, "objectKey"),
        contentHash: text(attachment.contentHash, "contentHash"),
        encodedBytes: Number(attachment.encodedBytes), mimeType: text(attachment.mimeType, "mimeType"),
        name: text(attachment.name, "name"),
        ...(attachment.presentationResidual === undefined ? {}
          : { presentationResidual: record(attachment.presentationResidual, "presentationResidual") }) };
    }),
  });
}
