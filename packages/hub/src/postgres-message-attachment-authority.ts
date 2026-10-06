import {
  MessageAuthorityError,
  PostgresMessageRepository,
  PostgresSpaceControlRepository,
  type AuthorityDatabase,
  type AuthorityDatabaseSession,
} from "@xmatrix/db";
import {
  createPostgresAuthorityDatabase,
  type PostgresAuthorityFleetEnv,
} from "./postgres-authority-fleet";
import { postgresMessageBoundedText } from "./postgres-message-authority";
import {
  POSTGRES_AUTHORITY_TIMEOUTS,
  postgresAuthorityJson,
  postgresAuthorityShardId,
  postgresControlErrorResponse,
  postgresRequestObject,
} from "./postgres-authority-http";

interface PostgresMessageAttachmentEnv extends PostgresAuthorityFleetEnv {
}

export async function postgresMessageAttachmentAuthorityRequest(
  env: PostgresMessageAttachmentEnv,
  input: Record<string, unknown>,
  dependencies: { database?: AuthorityDatabase } = {},
): Promise<Response> {
  let session: AuthorityDatabaseSession | undefined;
  try {
    const shardId = postgresAuthorityShardId(env, "message");
    const channelId = postgresMessageBoundedText(input.channelId, "channelId");
    const messageId = postgresMessageBoundedText(input.messageId, "messageId");
    const attachmentId = postgresMessageBoundedText(input.attachmentId, "attachmentId");
    const principal = postgresRequestObject(input.principal, () => new MessageAuthorityError(
      "invalid_command", 400, "principal is invalid"));
    if (principal.kind !== "user") throw new MessageAuthorityError(
      "forbidden", 403, "Only users may download message attachments",
    );
    const principalId = postgresMessageBoundedText(principal.id, "principal.id");
    const requestId = `message-attachment:${crypto.randomUUID()}`;
    const database = dependencies.database ?? createPostgresAuthorityDatabase(env, {
      applicationName: "xmatrix-hub-message-attachment", ...POSTGRES_AUTHORITY_TIMEOUTS,
    });
    session = database.openSession();
    const { spaceId, placement } = await new PostgresSpaceControlRepository(session, shardId)
      .resolveChannelSpacePlacement({ requestId, channelId });
    if (placement.state !== "active") throw new MessageAuthorityError(
      "space_placement_unavailable", 503, "Space placement is unavailable", true,
    );
    // Reuse the directory result only to route: the placed transaction still
    // fences its epoch and checks this user's message-content capability.
    const result = await new PostgresMessageRepository(session).attachmentAuthority({
      requestId, spaceId, channelId, messageId, attachmentId,
      principal: { kind: "user", id: principalId },
      placement,
    });
    return postgresAuthorityJson(result);
  } catch (error) {
    if (error instanceof MessageAuthorityError) return postgresControlErrorResponse(error);
    console.error("PostgreSQL message attachment authority failed", error);
    return postgresAuthorityJson({
      error: "Message attachment authority is unavailable",
      code: "postgres_message_attachment_unavailable",
      retryable: true,
    }, 503);
  } finally {
    await session?.close();
  }
}
