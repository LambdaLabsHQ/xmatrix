import {
  DatabaseCommitUnknownError,
  ContentControlError,
  MessageAuthorityError,
  PostgresMessageRepository,
  PostgresSpaceControlRepository,
  SpaceControlError,
  type AuthorityDatabase,
  type DingTalkEffectAuthority,
  type AuthorityDatabaseSession,
  type AppendPostgresMessage,
  type MessagePrincipal,
  type PostgresMessageSenderIdentity,
  type PostgresMessageAgentRunIdentity,
  type PostgresMessagePlacement,
  type MessageSearchCandidate,
  XMATRIX_SYSTEM_AUTHOR_ID,
} from "@xmatrix/db";

import type { AppendMessageCommand, AuthorityPrincipal } from "./product-message-command";
import { agentAvatarUrlFromMetadata, CHANNEL_ACTIVITY_MESSAGE_KIND, messagePublicationEvidence, normalizeAgentPresetRuntime,
  supersededByOf, sha256Hex , utf8ByteLength, type MessageSearchHit, type MessageSearchPage } from "@xmatrix/protocol";
import { REDACTED_CONTENT_HASH, productGatewayAttachmentKind } from "./product-message-command";
import { XMATRIX_SYSTEM_AVATAR_URL, XMATRIX_SYSTEM_LABEL } from "./xmatrix-system-identity";
import {
  decodeRelayV2MessagePayloadBundle,
  prepareRelayV2MessageRecord,
  relayV2MessageRichFieldsFromBundle,
  RELAY_V2_MESSAGE_PAYLOAD_SCHEMA_VERSION,
} from "./relay-v2-message-record";
import { appConnectorMessageSenderSnapshot, getAppConnectorProvider } from "./app-connectors";
import {
  base64UrlDecodeBytes,
  base64UrlEncodeBytes,
  canonicalJson,
} from "./relay-v2-primitives";
import { productMessageSenderPresentation } from "./message-sender-presentation";
import { compactMessageBodyPreview } from "./message-body-preview";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { postgresRetryAfterSeconds, retryablePostgresFailure } from "./postgres-error-classification";
import {
  logSlowMessageCoordination,
  recordMessageCoordination,
  type MessageCoordinationDurations,
} from "./postgres-coordination-observability";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "./postgres-message-database-policy";
import type { Env } from "./types";

import { postgresPrincipalKind } from "./postgres-authority-http";

export type PostgresMessageDependencies = {
  database?: AuthorityDatabase;
  recoveryDatabase?: AuthorityDatabase;
  requestScoped?: boolean;
  placement?: PostgresMessagePlacement;
};
export interface PostgresRequestScope {
  database: AuthorityDatabaseSession;
  recoveryDatabase: AuthorityDatabase;
  requestScoped: true;
  close(): Promise<void>;
}
type PostgresMessageQueryInput = { channelId: string; principal: AuthorityPrincipal };

export function postgresMessageBoundedText(
  value: unknown,
  field: string,
  maximumBytes = 300,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || utf8ByteLength(normalized) > maximumBytes) {
    throw new MessageAuthorityError("invalid_command", 400, `${field} is invalid`);
  }
  return normalized;
}

const bounded = postgresMessageBoundedText;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MessageAuthorityError("invalid_command", 400, `${field} is invalid`);
  }
  return value as Record<string, unknown>;
}

/** How xMatrix's own messages present their author. */
const XMATRIX_MESSAGE_SENDER_SNAPSHOT = {
  identityId: `system:${XMATRIX_SYSTEM_AUTHOR_ID}`, kind: "system", userId: "", email: "",
  label: XMATRIX_SYSTEM_LABEL, name: XMATRIX_SYSTEM_LABEL, avatarUrl: XMATRIX_SYSTEM_AVATAR_URL,
};

function principal(value: unknown): MessagePrincipal {
  const input = record(value, "principal");
  const kind = postgresPrincipalKind(input.kind, () => new MessageAuthorityError("invalid_principal", 400, "principal is invalid"));
  return { kind, id: bounded(input.id, "principal.id") };
}

/** An imported author as they appeared where they wrote it; no xMatrix account stands behind them. */
function importedSenderSnapshot(author: NonNullable<AppendMessageCommand["importedAuthor"]>,
  senderId: string): Record<string, unknown> {
  const name = bounded(author.name, "importedAuthor.name");
  return {
    identityId: `user:${senderId}`, kind: "user", userId: senderId, label: name, name,
    email: author.email ?? "",
    ...(author.avatarUrl ? { avatarUrl: author.avatarUrl } : {}),
  };
}

function postgresSenderSnapshot(
  identity: PostgresMessageSenderIdentity,
  runIdentity?: PostgresMessageAgentRunIdentity,
): Record<string, unknown> {
  const identityId = identity.kind === "user" ? `user:${identity.id}` : identity.id;
  if (identity.kind === "user") return {
    identityId, kind: "user", userId: identity.id,
    ...(identity.displayName ? { label: identity.displayName } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
    catalogVersion: identity.version,
  };
  // A registration's assigned role avatar rides in its identity metadata.
  const avatarUrl = agentAvatarUrlFromMetadata(identity.metadata,
    normalizeAgentPresetRuntime(identity.runtime) ?? identity.runtime);
  const channelInstanceId = runIdentity ? String(runIdentity.channelInstanceId) : undefined;
  const instanceLabel = channelInstanceId ? `${identity.name}:${channelInstanceId}` : undefined;
  return {
    /* The Instance row this append already read carries the header's tags, so
       the send-time snapshot is fixed by the same transaction that authorized
       the message. The caller's overlay is merged under this one, so the row
       wins key by key and a caller only fills what the row does not carry --
       an Instance whose first message outruns its first presentation write
       still stamps a header. */
    ...agentSenderPresentation(runIdentity?.presentation),
    identityId, kind: "agent", agentId: identity.id, label: instanceLabel ?? identity.name,
    name: identity.name, agentName: identity.name, runtime: identity.runtime,
    userId: identity.ownerUserId,
    ...(runIdentity ? { registration: runIdentity.registration } : {}),
    ...(runIdentity ? {
      instanceId: runIdentity.instanceId,
      channelInstanceId,
      instanceLabel,
    } : {}),
    ...(runIdentity?.origin ? {
      originChannelId: runIdentity.origin.channelId,
      ...(runIdentity.origin.messageId ? { originMessageId: runIdentity.origin.messageId } : {}),
    } : {}),
    ...(identity.ownerEmail ? { email: identity.ownerEmail } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    profileVersion: identity.version,
  };
}

/** A link's origin is stamped from the Run's own records; a caller-built
 *  snapshot can never claim one. */
function withoutCallerOrigin(snapshot: Record<string, unknown>): Record<string, unknown> {
  const { originChannelId: _channel, originMessageId: _message, ...rest } = snapshot;
  return rest;
}

function agentSenderPresentation(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    ["goal", "gitBranch", "model", "effort", "statusChips"]
      .filter((key) => Object.prototype.hasOwnProperty.call(input, key))
      .map((key) => [key, input[key]]),
  );
}

function database(env: Env): AuthorityDatabase {
  const connectionString = env.RELAY_POSTGRES?.connectionString;
  const shardId = env.RELAY_POSTGRES_SHARD_ID?.trim();
  if (!connectionString || !shardId) {
    throw new Error("PostgreSQL message authority bindings are unavailable");
  }
  return createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-message-authority",
    connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS,
    statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000,
    lockTimeoutMs: 2_000,
  });
}

export function openPostgresMessageRequestScope(
  env: Env,
  dependencies: { database?: AuthorityDatabase } = {},
): PostgresRequestScope {
  const recoveryDatabase = dependencies.database ?? database(env);
  const requestDatabase = recoveryDatabase.openSession();
  return {
    database: requestDatabase,
    recoveryDatabase,
    requestScoped: true,
    close: () => requestDatabase.close(),
  };
}

export async function withPostgresMessageRequestScope<T>(
  env: Env,
  operation: (scope: PostgresRequestScope) => Promise<T>,
): Promise<T> {
  const scope = openPostgresMessageRequestScope(env);
  try {
    return await operation(scope);
  } finally {
    await scope.close();
  }
}

function configuredShardId(env: Env): string {
  const shardId = env.RELAY_POSTGRES_SHARD_ID?.trim();
  if (!shardId) throw new Error("PostgreSQL message shard identity is unavailable");
  return shardId;
}

function postgresPreparedMessage(
  prepared: Awaited<ReturnType<typeof prepareRelayV2MessageRecord>>,
) {
  // Chat lists show this, not the payload: derive it from exactly the bundle stored beside it.
  const bundle = decodeRelayV2MessagePayloadBundle(prepared.payloadBundleBytes);
  return {
    preview: { bodyPreview: compactMessageBodyPreview(bundle.body), senderSnapshot: bundle.senderSnapshot },
    codecId: prepared.codecId,
    payloadSchemaVersion: prepared.payloadSchemaVersion,
    fieldPresenceBase64: base64UrlEncodeBytes(prepared.fieldPresenceBytes),
    payloadBundleBase64: base64UrlEncodeBytes(prepared.payloadBundleBytes),
    bodyHash: prepared.bodyHash,
    senderSnapshotDigest: prepared.senderSnapshotDigest,
    recordDigest: prepared.recordDigest,
    recordEncodedBytes: prepared.recordEncodedBytes,
  };
}

async function postgresMessageContext(
  env: Env,
  channelIdValue: string,
  requestId: string,
  authorityDatabase = database(env),
  requestScoped = false,
) {
  const channelId = bounded(channelIdValue, "channelId");
  const spaceId = await new PostgresSpaceControlRepository(
    authorityDatabase, configuredShardId(env),
  ).resolveChannelSpaceId({ requestId, channelId });
  return {
    authorityDatabase,
    channelId,
    spaceId,
    messages: new PostgresMessageRepository(authorityDatabase, requestScoped),
  };
}

async function postgresMessageCommandContext(
  env: Env,
  channelIdValue: string,
  input: Record<string, unknown>,
  operation: string,
  authorityDatabase: AuthorityDatabase,
  requestScoped = false,
) {
  const commandId = bounded(input.commandId, "commandId");
  const actor = principal(input.principal);
  const requestId = `${operation}:${commandId}`.slice(0, 200);
  return {
    commandId,
    actor,
    requestId,
    ...await postgresMessageContext(
      env, channelIdValue, requestId, authorityDatabase, requestScoped,
    ),
  };
}

async function postgresMessageCommandContextFromDependencies(
  env: Env,
  channelId: string,
  input: Record<string, unknown>,
  operation: string,
  dependencies: PostgresMessageDependencies,
) {
  return postgresMessageCommandContext(
    env, channelId, input, operation, dependencies.database ?? database(env),
    dependencies.requestScoped === true,
  );
}

async function postgresMessageCommandContextFromInput(
  env: Env,
  input: Record<string, unknown>,
  operation: string,
  dependencies: PostgresMessageDependencies,
) {
  return postgresMessageCommandContextFromDependencies(
    env, String(input.channelId || ""), input, operation, dependencies,
  );
}

async function postgresMessageQueryContext(
  env: Env,
  input: { channelId: string; principal: AuthorityPrincipal },
  operation: string,
  authorityDatabase: AuthorityDatabase,
  requestScoped = false,
) {
  const actor = principal(input.principal);
  const requestId = `${operation}:${crypto.randomUUID()}`;
  return {
    actor,
    requestId,
    ...await postgresMessageContext(
      env, input.channelId, requestId, authorityDatabase, requestScoped,
    ),
  };
}

async function postgresMessageQueryContextFromDependencies(
  env: Env,
  input: PostgresMessageQueryInput,
  operation: string,
  dependencies: PostgresMessageDependencies,
) {
  return postgresMessageQueryContext(
    env, input, operation, dependencies.database ?? database(env),
    dependencies.requestScoped === true,
  );
}

/**
 * A message operation's failure as its status and public body. HTTP routes
 * answer it as a Response; runtime sockets carry it as a classified failure.
 */
export function postgresMessageFailure(error: unknown): {
  status: number;
  body: { error: string; code: string; retryable: boolean };
  /** A database outage rather than a decided rejection. */
  outage: boolean;
} {
  // Every message operation first resolves its Channel through Space control,
  // which answers an unknown Channel with a 404 of its own. That is the
  // caller's fact to see, not a failed request.
  if (error instanceof MessageAuthorityError || error instanceof ContentControlError ||
      (error instanceof SpaceControlError && error.status < 500)) {
    return { status: error.status, body: { error: error.message, code: error.code, retryable: error.retryable },
      outage: false };
  }
  console.error("PostgreSQL message authority failed", error);
  const outage = retryablePostgresFailure(error);
  return outage
    ? { status: 503, outage, body: { error: "PostgreSQL message authority is unavailable",
      code: "postgres_message_authority_unavailable", retryable: true } }
    : { status: 500, outage, body: { error: "PostgreSQL message request failed",
      code: "postgres_message_authority_internal_error", retryable: false } };
}

export function postgresMessageErrorResponse(error: unknown): Response {
  const failure = postgresMessageFailure(error);
  return Response.json(failure.body, {
    status: failure.status,
    headers: {
      "cache-control": "private, no-store",
      ...(failure.outage ? { "retry-after": String(postgresRetryAfterSeconds(error)) } : {}),
    },
  });
}

export async function postgresMessageAppend(
  env: Env,
  channelIdValue: string,
  commandValue: Record<string, unknown>,
  dependencies: PostgresMessageDependencies & { spaceId?: string; agentSendFingerprint?: string; dingtalkEffect?: DingTalkEffectAuthority } = {},
): Promise<Record<string, unknown>> {
  const channelId = bounded(channelIdValue, "channelId");
  const command = commandValue as unknown as AppendMessageCommand & {
    sealedAttachments?: Record<string, unknown>[];
  };
  const commandId = bounded(command.commandId, "commandId");
  const messageId = bounded(command.messageId, "messageId");
  const actor = principal(command.principal);
  const appAuthorId = command.appAuthorId === undefined
    ? undefined
    : bounded(command.appAuthorId, "appAuthorId");
  if (appAuthorId && (!getAppConnectorProvider(appAuthorId) || command.agentRunProof ||
      command.senderId !== undefined || command.threadRootCopyAuthorKind)) {
    throw new MessageAuthorityError("invalid_command", 400, "App message author is invalid");
  }
  const xmatrixAuthor = command.xmatrixAuthor === true;
  if (xmatrixAuthor && (appAuthorId || command.agentRunProof || command.senderId !== undefined ||
      command.threadRootCopyAuthorKind || actor.kind !== "user")) {
    throw new MessageAuthorityError("invalid_command", 400, "xMatrix message author is invalid");
  }
  const imported = command.importedAuthor;
  if (imported && (appAuthorId || xmatrixAuthor || command.agentRunProof || command.senderId !== undefined ||
      command.threadRootCopyAuthorKind || actor.kind !== "user")) {
    throw new MessageAuthorityError("invalid_command", 400, "Imported message author is invalid");
  }
  // App, xMatrix and imported messages present their own author; principal still authorizes them.
  const presentedAuthor = appAuthorId ? { kind: "app" as const, id: appAuthorId }
    : xmatrixAuthor ? { kind: "system" as const, id: XMATRIX_SYSTEM_AUTHOR_ID }
    : imported ? { kind: "user" as const, id: bounded(`${imported.source}:${imported.id}`, "importedAuthor.id") }
    : undefined;
  const senderKind: AppendPostgresMessage["senderKind"] = presentedAuthor?.kind ?? command.threadRootCopyAuthorKind ?? actor.kind;
  const senderId = presentedAuthor?.id ?? bounded(command.senderId ?? actor.id, "senderId");
  const messageKind = bounded(command.messageKind ?? "xmatrix.message.text", "messageKind");
  const sentAt = command.sentAt ? new Date(command.sentAt).toISOString() : new Date().toISOString();
  if (!Number.isFinite(Date.parse(sentAt)) || typeof command.body !== "string") {
    throw new MessageAuthorityError("invalid_command", 400, "message payload is invalid");
  }
  const startedAt = performance.now();
  const durations: MessageCoordinationDurations = {
    routeMs: 0, prepareMs: 0, reserveMs: 0, encodeMs: 0,
    appendMs: 0, confirmMs: 0, totalMs: 0,
  };
  let observedSpaceId: string | undefined;
  try {
    const runProof = command.agentRunProof ? {
      runId: command.agentRunProof.runId,
      executionKey: command.agentRunProof.executionKey,
      instanceId: command.agentRunProof.instanceId,
    } : undefined;
    let phaseStartedAt = performance.now();
    const authorityDatabase = dependencies.database ?? database(env);
    const spaceId = dependencies.spaceId
      ? bounded(dependencies.spaceId, "spaceId")
      : await new PostgresSpaceControlRepository(
          authorityDatabase, configuredShardId(env),
        ).resolveChannelSpaceId({
          requestId: `message-space:${commandId}`.slice(0, 200), channelId,
        });
    observedSpaceId = spaceId;
    durations.routeMs = performance.now() - phaseStartedAt;
    const messages = new PostgresMessageRepository(
      authorityDatabase,
      dependencies.requestScoped === true,
    );
    phaseStartedAt = performance.now();
    const preparedContext = await messages.prepareAppend({
      requestId: `message-prepare:${commandId}`.slice(0, 200),
      spaceId,
      channelId,
      principal: actor,
      ...(presentedAuthor ? {} : {
        senderPrincipal: {
          kind: senderKind as "user" | "agent",
          id: senderId,
        },
      }),
      runProof,
      ...(dependencies.placement ? { placement: dependencies.placement } : {}),
    });
    durations.prepareMs = performance.now() - phaseStartedAt;
    phaseStartedAt = performance.now();
    const canonicalSenderSnapshot = presentedAuthor
      ? undefined
      : postgresSenderSnapshot(preparedContext.senderIdentity!, preparedContext.agentRunIdentity);
    const senderSnapshot = appAuthorId
      ? appConnectorMessageSenderSnapshot(appAuthorId)
      : xmatrixAuthor ? XMATRIX_MESSAGE_SENDER_SNAPSHOT
      : imported ? importedSenderSnapshot(imported, senderId)
      : runProof
      ? {
          ...agentSenderPresentation(command.senderSnapshot),
          ...canonicalSenderSnapshot,
        }
      : command.senderSnapshot === undefined
      ? canonicalSenderSnapshot!
      : withoutCallerOrigin(record(command.senderSnapshot, "senderSnapshot"));
    const reservation = await messages.reserveAppendSequence({
      requestId: `message-reserve:${commandId}`.slice(0, 200),
      spaceId,
      channelId,
      commandId,
      observedPostgresHead: preparedContext.sequence,
      ...(dependencies.placement ? { placement: dependencies.placement } : {}),
    });
    durations.reserveMs = performance.now() - phaseStartedAt;
    phaseStartedAt = performance.now();
    const prepared = await prepareRelayV2MessageRecord({
      messageId,
      channelId,
      timelineSequence: reservation.sequence,
      senderKind,
      senderId,
      messageKind,
      payloadSchemaVersion: RELAY_V2_MESSAGE_PAYLOAD_SCHEMA_VERSION,
      entityVersion: 1,
      sentAt,
      body: command.body,
      senderSnapshot,
      ...(Object.prototype.hasOwnProperty.call(command, "residual")
        ? { residual: command.residual! }
        : {}),
    });
    const {
      sealedAttachments: _sealedAttachments,
      resolvedAttentionTargets: _resolvedAttentionTargets,
      ...digestCommand
    } = command;
    const requestDigest = await sha256Hex(canonicalJson(JSON.parse(JSON.stringify(
      command.agentRunProof ? { ...digestCommand, senderSnapshot: undefined } : digestCommand,
    ))));
    durations.encodeMs = performance.now() - phaseStartedAt;
    const appendInput = {
      requestId: `message-append:${commandId}`.slice(0, 200),
      commandId,
      spaceId,
      channelId,
      messageId,
      sequence: reservation.sequence,
      principal: actor,
      senderKind,
      senderId,
      messageKind,
      sentAt,
      requestDigest,
      prepared: postgresPreparedMessage(prepared),
      agentSendFingerprint: dependencies.agentSendFingerprint,
      finalReplyExecutionId: command.finalReplyExecutionId,
      senderSnapshot,
      // An activity entry carries the Agent's own step titles, and imported
      // history replays what was said elsewhere: neither mentions nor commands.
      attentionBody: messageKind === CHANNEL_ACTIVITY_MESSAGE_KIND || imported ? "" : command.body,
      invocationSelections: command.invocationSelections,
      runProof,
      attachments: command.sealedAttachments,
      attachmentOwnerUserId: command.sealedAttachments?.length
        ? bounded(
            command.authorityRootUserId ??
              (typeof senderSnapshot.userId === "string" ? senderSnapshot.userId : ""),
            "attachmentOwnerUserId",
          )
        : undefined,
      replyToMessageId: typeof command.residual?.replyToMessageId === "string"
        ? command.residual.replyToMessageId : undefined,
      ...(dependencies.placement ? { placement: dependencies.placement } : {}),
    };
    let result: Record<string, unknown>;
    phaseStartedAt = performance.now();
    try {
      result = await messages.append(appendInput,dependencies.dingtalkEffect);
    } catch (error) {
      if (!(error instanceof DatabaseCommitUnknownError)) throw error;
      const recovery = new PostgresMessageRepository(
        dependencies.recoveryDatabase ?? authorityDatabase,
      );
      result = await recovery.reconcileAppend({
        requestId: `message-reconcile:${commandId}`.slice(0, 200),
        commandId,
        requestDigest,
        spaceId,
      },dependencies.dingtalkEffect ? { authority: dependencies.dingtalkEffect,bodyHash: appendInput.prepared.bodyHash } : undefined) ?? await recovery.append({
        ...appendInput,
        requestId: `message-retry:${commandId}`.slice(0, 200),
      },dependencies.dingtalkEffect);
    }
    durations.appendMs = performance.now() - phaseStartedAt;
    durations.confirmMs = 0;
    durations.totalMs = performance.now() - startedAt;
    recordMessageCoordination({ env, outcome: "ok", durations });
    logSlowMessageCoordination({
      outcome: "ok", commandId, spaceId, channelId, durations,
    });
    return result;
  } catch (error) {
    durations.totalMs = performance.now() - startedAt;
    const errorCode = error instanceof MessageAuthorityError
      ? error.code
      : error instanceof Error ? error.name : "unknown";
    recordMessageCoordination({ env, outcome: "error", errorCode, durations });
    logSlowMessageCoordination({
      outcome: "error", commandId, spaceId: observedSpaceId, channelId, errorCode, durations,
    });
    throw error;
  }
}

export async function postgresMessageRoute(
  env: Env,
  channelId: string,
  requestId: string,
  dependencies: { database?: AuthorityDatabase } = {},
): Promise<PostgresMessagePlacement> {
  const authorityDatabase = dependencies.database ?? database(env);
  const route = await new PostgresSpaceControlRepository(
    authorityDatabase, configuredShardId(env),
  ).resolveChannelSpaceRoute({ requestId, channelId });
  return {
    spaceId: route.spaceId,
    shardId: route.shardId,
    placementEpoch: route.placementEpoch,
  };
}

export async function postgresMessageReceipt(
  env: Env,
  input: PostgresMessageQueryInput & { messageId: string; expectedBodyHash?: string;
    runProof?: AppendPostgresMessage["runProof"] },
  dependencies: PostgresMessageDependencies = {},
) {
  const context = await postgresMessageQueryContextFromDependencies(env, input, "http-append-receipt", dependencies);
  return context.messages.httpAppendReceipt({ requestId: context.requestId, spaceId: context.spaceId,
    channelId: context.channelId, principal: context.actor, messageId: input.messageId,
    runProof: input.runProof, expectedBodyHash: input.expectedBodyHash });
}

export async function postgresMessageHistory(
  env: Env,
  input: {
    channelId: string;
    before?: string;
    beforeSequence?: number;
    afterSequence?: number;
    limit?: number;
    principal: AuthorityPrincipal;
  },
  dependencies: PostgresMessageDependencies = {},
): Promise<Record<string, unknown>> {
  // The Channel's route and its Space placement arrive in one directory read;
  // the page read still takes that placement's fence and checks the reader.
  const actor = principal(input.principal);
  const requestId = `message-history:${crypto.randomUUID()}`;
  const channelId = bounded(input.channelId, "channelId");
  const authorityDatabase = dependencies.database ?? database(env);
  const { spaceId, placement } = await new PostgresSpaceControlRepository(
    authorityDatabase, configuredShardId(env),
  ).resolveChannelSpacePlacement({ requestId, channelId });
  const repository = new PostgresMessageRepository(
    authorityDatabase, dependencies.requestScoped === true,
  );
  const result = await repository.history({
    requestId, spaceId, channelId, principal: actor, resolvedPlacement: placement,
    before: input.before,
    beforeSequence: input.beforeSequence,
    afterSequence: input.afterSequence,
    limit: input.limit,
  });
  const candidates = result.messages.map(postgresProductMessage);
  const forward = input.afterSequence !== undefined;
  const ordered = forward ? candidates : candidates.slice().reverse();
  const selected: typeof candidates = [];
  let pageBytes = 0;
  const pageByteBudget = 4 * 1024 * 1024;
  for (const message of ordered) {
    const bytes = utf8ByteLength(JSON.stringify(message)) + 512;
    if (pageBytes + bytes > pageByteBudget) {
      if (selected.length === 0) throw new MessageAuthorityError(
        "history_message_exceeds_page_budget", 413, "Message exceeds the history page byte budget");
      break;
    }
    selected.push(message);
    pageBytes += bytes;
  }
  if (result.aboutInput && selected.length !== candidates.length) throw new MessageAuthorityError(
    "about_history_page_budget", 413, "About history page exceeds byte budget; retry with a smaller limit");
  const messages = forward ? selected : selected.slice().reverse();
  return {
    ...(result.aboutInput ? { aboutInput: result.aboutInput } : {}),
    channelId,
    messages,
    hasMore: result.hasMore || selected.length < candidates.length,
    historyHeadSequence: result.historyHeadSequence,
    contentAuthority: { protocolVersion: 1, contentRevision: result.contentRevision },
    principalAckedSequence: result.principalAckedSequence,
    fullHistory: {
      sources: ["postgres-authority", "immutable-payload-objects"],
      independentOfLongLivedProjection: true,
      admissibleForSteadyState: true,
      canCompleteWithoutLongLivedProjection: true,
    },
  };
}

function postgresProductThreadSummary(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const summary = value as Record<string, unknown>;
  const channelId = typeof summary.channelId === "string" ? summary.channelId : "";
  const updatedAt = typeof summary.updatedAt === "string" ? summary.updatedAt : "";
  const replyCount = Number(summary.replyCount);
  if (!channelId || !updatedAt || !Number.isSafeInteger(replyCount) || replyCount < 0) return undefined;
  const replies = Array.isArray(summary.replies)
    ? summary.replies.filter((reply): reply is Record<string, unknown> =>
      Boolean(reply) && typeof reply === "object" && !Array.isArray(reply))
      .slice(0, 2)
      .map(postgresProductMessage)
    : [];
  return {
    channelId,
    updatedAt,
    replyCount,
    replies,
  };
}

export function postgresProductMessage(message: Record<string, unknown>): Record<string, unknown> {
    const payload = typeof message.payloadBundleBase64 === "string"
      ? decodeRelayV2MessagePayloadBundle(base64UrlDecodeBytes(message.payloadBundleBase64))
      : null;
    const senderKind = String(message.senderKind || "user");
    const senderId = String(message.senderId || "");
    const rich = relayV2MessageRichFieldsFromBundle(payload);
    const thread = postgresProductThreadSummary(message.threadSummary);
    // A recalled or deleted row has no snapshot; history resolves its author.
    const tombstoneSender = message.tombstoneSender && typeof message.tombstoneSender === "object" &&
        !Array.isArray(message.tombstoneSender)
      ? message.tombstoneSender as Record<string, unknown> : undefined;
    return {
      messageId: message.messageId,
      channelId: message.channelId,
      sequence: message.sequence,
      ...(payload ? messagePublicationEvidence(message) : {}),
      from: payload
        ? productMessageSenderPresentation(payload.senderSnapshot, senderKind, senderId)
        : tombstoneSender && (senderKind === "user" || senderKind === "agent")
          ? productMessageSenderPresentation(tombstoneSender, senderKind, senderId)
          : { identityId: senderKind === "user" ? `user:${senderId}` : senderId,
              kind: senderKind, label: senderId, userId: senderKind === "user" ? senderId : "", email: "" },
      body: message.recalledAt ? "" : payload?.body ?? "",
      sentAt: message.sentAt,
      ...(message.editedAt && !message.recalledAt ? { editedAt: message.editedAt } : {}),
      ...(message.recalledAt ? { recalledAt: message.recalledAt } : {}),
      ...(payload ? {
        messageKind: message.messageKind,
        payloadSchemaVersion: message.payloadSchemaVersion,
        senderSnapshot: payload.senderSnapshot,
        ...(Object.prototype.hasOwnProperty.call(payload, "residual")
          ? { messageResidual: payload.residual }
          : {}),
        ...(!message.recalledAt && !message.deletedAt ? { bodyHash: message.bodyHash } : {}),
        senderSnapshotDigest: message.senderSnapshotDigest,
        recordDigest: message.recordDigest,
      } : {}),
      reactions: message.reactions,
      annotations: message.annotations,
      ...(!message.recalledAt && supersededByOf(message.annotations)
        ? { supersededBy: supersededByOf(message.annotations) } : {}),
      // A withdrawn message withdraws its files too: their bytes already answer 404.
      attachments: message.recalledAt || message.deletedAt ? [] : Array.isArray(message.attachments)
        ? message.attachments.map((attachment: Record<string, unknown>) => ({
            ...attachment,
            channelId: message.channelId,
            messageId: message.messageId,
            kind: productGatewayAttachmentKind(String(attachment.mimeType ?? "")),
          }))
        : message.attachments,
      ...(rich.replyToMessageId ? { replyToMessageId: rich.replyToMessageId } : {}),
      ...(rich.appMetadata ? { metadata: rich.appMetadata } : {}),
      ...(thread ? { thread } : {}),
    };
}

export async function postgresMessageAcknowledge(
  env: Env,
  channelIdValue: string,
  input: Record<string, unknown>,
  dependencies: PostgresMessageDependencies = {},
) {
  const { commandId, actor, requestId, channelId, spaceId, messages } =
    await postgresMessageCommandContextFromDependencies(
      env, channelIdValue, input, "message-ack", dependencies,
    );
  const sequence = input.sequence === undefined ? undefined : Number(input.sequence);
  const messageId = input.messageId === undefined ? undefined : bounded(input.messageId, "messageId");
  const requestDigest = await sha256Hex(canonicalJson({
    channelId, principal: actor,
    ...(sequence === undefined ? {} : { sequence }),
    ...(messageId === undefined ? {} : { messageId }),
  }));
  return messages.acknowledge({
    requestId, commandId, requestDigest, spaceId, channelId, principal: actor, sequence, messageId,
  });
}

export async function postgresMessageMutation(
  env: Env,
  family: "edit-message" | "recall-message" | "delete-message" |
    "message-reaction" | "message-annotation" | "message-attachment" |
    "message-rich-reply-app-metadata",
  input: Record<string, unknown>,
  dependencies: PostgresMessageDependencies = {},
): Promise<Record<string, unknown>> {
  const { commandId, actor, requestId, channelId, spaceId, messages } =
    await postgresMessageCommandContextFromInput(env, input, "message-mutation", dependencies);
  let messageId = typeof input.messageId === "string" ? input.messageId.trim() : "";
  if (!messageId && family === "message-annotation" && input.action === "remove") {
    messageId = await messages.annotationMessageId({
      requestId, spaceId, channelId,
      annotationId: bounded(input.annotationId, "annotationId"), principal: actor,
    });
  }
  messageId = bounded(messageId, "messageId");
  const candidate = await messages.mutationCandidate({
    requestId, spaceId, channelId, messageId, principal: actor,
    // A reaction is the reactor's own response, not a change to the message.
    access: family === "message-reaction" ? "participant" : "author",
    includeDeleted: family === "delete-message",
  });
  const expectedEntityVersion = input.expectedEntityVersion === undefined
    ? Number(candidate.entityVersion)
    : Number(input.expectedEntityVersion);
  const { sealedAttachments: _sealedAttachments, ...digestInput } = input;
  const requestDigest = await sha256Hex(canonicalJson(JSON.parse(JSON.stringify({
    family, input: digestInput,
  }))));
  const base = {
    requestId, commandId, requestDigest, spaceId, channelId, messageId,
    expectedEntityVersion, principal: actor,
  };
  if (family === "recall-message" || family === "delete-message") {
    const result = await messages.tombstone({
      ...base,
      kind: family === "recall-message" ? "recall" : "delete",
      redactedContentHash: REDACTED_CONTENT_HASH,
    });
    return {
      ...result,
      tombstoneMessage: {
        messageId, channelId, sequence: result.sequence, entityVersion: result.entityVersion,
        from: postgresProductMessage(candidate).from, body: "", sentAt: candidate.sentAt,
        ...(family === "delete-message"
          ? { deletedAt: result.deletedAt } : { recalledAt: result.recalledAt }),
      },
    };
  }
  if (family === "edit-message" || family === "message-rich-reply-app-metadata") {
    if (typeof candidate.payloadBundleBase64 !== "string") {
      throw new MessageAuthorityError(
        "message_payload_not_local", 409, "Archived message payload must be restored before mutation",
      );
    }
    const bundle = decodeRelayV2MessagePayloadBundle(
      base64UrlDecodeBytes(candidate.payloadBundleBase64),
    );
    const body = family === "edit-message" ? input.body : bundle.body;
    if (typeof body !== "string" || utf8ByteLength(body) > 64 * 1024) {
      throw new MessageAuthorityError("invalid_command", 400, "body is invalid");
    }
    const residual = family === "message-rich-reply-app-metadata"
      ? {
          ...(Object.prototype.hasOwnProperty.call(bundle, "residual") ? bundle.residual : {}),
          ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
          ...(input.appMetadata === undefined ? {} : { appMetadata: input.appMetadata }),
        }
      : bundle.residual;
    const editedAt = new Date().toISOString();
    const prepared = await prepareRelayV2MessageRecord({
      messageId, channelId,
      timelineSequence: Number(candidate.sequence),
      senderKind: String(candidate.senderKind),
      senderId: String(candidate.senderId),
      messageKind: String(candidate.messageKind),
      payloadSchemaVersion: RELAY_V2_MESSAGE_PAYLOAD_SCHEMA_VERSION,
      entityVersion: expectedEntityVersion + 1,
      sentAt: String(candidate.sentAt),
      editedAt,
      body,
      senderSnapshot: bundle.senderSnapshot,
      ...(residual === undefined ? {} : { residual }),
    });
    return messages.updatePrepared({
      ...base,
      editedAt,
      prepared: postgresPreparedMessage(prepared),
    });
  }
  if (family === "message-reaction") {
    if (actor.kind === "user" && input.actorUserId !== undefined && input.actorUserId !== actor.id) {
      throw new MessageAuthorityError("forbidden", 403, "Reaction actor is invalid");
    }
    return messages.mutateCollection({
      ...base, kind: "reaction",
      emoji: bounded(input.emoji, "emoji"),
      reactorLabel: bounded(input.reactorLabel ?? actor.id, "reactorLabel"),
    });
  }
  if (family === "message-annotation") {
    if (actor.kind !== "user" ||
        (input.actorUserId !== undefined && input.actorUserId !== actor.id)) {
      throw new MessageAuthorityError("forbidden", 403, "Annotation actor is invalid");
    }
    const action = input.action === "remove" ? "remove" : "upsert";
    return messages.mutateCollection({
      ...base, kind: "annotation", action,
      annotationId: bounded(input.annotationId, "annotationId"),
      ...(action === "remove" ? {} : {
        namespace: bounded(input.namespace, "namespace"),
        payload: record(input.payload ?? {}, "payload"),
        authorLabel: bounded(input.authorLabel ?? actor.id, "authorLabel"),
      }),
    });
  }
  return messages.mutateCollection({
    ...base, kind: "attachment",
    action: input.action === "remove" ? "remove" : "add",
    ...(input.action === "remove"
      ? { attachmentId: bounded(input.attachmentId, "attachmentId") }
      : { sealedAttachments: Array.isArray(input.sealedAttachments)
          ? input.sealedAttachments as Record<string, unknown>[] : undefined,
          attachmentOwnerUserId: bounded(
            input.actorUserId ?? input.authorityRootUserId ?? actor.id,
            "attachmentOwnerUserId",
          ) }),
  });
}

/**
 * Record the Hub's own judgment about a message as a `system` annotation in a
 * reserved namespace (docs/design/conversation-activity.md §3.3). Not reachable
 * from any public route.
 */
export async function postgresMessageSystemAnnotation(
  env: Env,
  input: {
    channelId: string;
    messageId: string;
    namespace: string;
    annotationId: string;
    payload: Record<string, unknown>;
  },
  dependencies: PostgresMessageDependencies = {},
): Promise<Record<string, unknown> | null> {
  const requestId = `message-system-annotation:${crypto.randomUUID()}`;
  const { channelId, spaceId, messages } = await postgresMessageContext(
    env, input.channelId, requestId, dependencies.database ?? database(env),
    dependencies.requestScoped === true,
  );
  return messages.annotateAsSystem({
    requestId, spaceId, channelId,
    messageId: input.messageId,
    namespace: input.namespace,
    annotationId: input.annotationId,
    payload: input.payload,
    requestDigest: await sha256Hex(JSON.stringify([input.namespace, input.messageId, input.payload])),
  });
}

export async function postgresMessageAnnotations(
  env: Env,
  input: {
    channelId: string;
    namespace?: string;
    messageId?: string;
    afterCreatedAt?: string;
    principal: AuthorityPrincipal;
  },
  dependencies: PostgresMessageDependencies = {},
): Promise<Record<string, unknown>> {
  const { actor, requestId, channelId, spaceId, messages } =
    await postgresMessageQueryContextFromDependencies(
      env, input, "message-annotations", dependencies,
    );
  return messages.listAnnotations({
    requestId, spaceId, channelId, principal: actor,
    namespace: input.namespace,
    messageId: input.messageId,
    afterCreatedAt: input.afterCreatedAt,
  });
}

async function postgresMessageBackgroundContext(env: Env, channelId: string,
  operation: string, dependencies: PostgresMessageDependencies) {
  const requestId = `${operation}:${crypto.randomUUID()}`;
  return { requestId, ...await postgresMessageContext(env, channelId, requestId,
    dependencies.database ?? database(env), dependencies.requestScoped === true) };
}

export async function postgresMessageLiveDeliveryRouting(
  env: Env,
  channelId: string,
  messageId: string,
  dependencies: PostgresMessageDependencies = {},
) {
  const context = await postgresMessageBackgroundContext(env, channelId, "message-live-routing", dependencies);
  return context.messages.liveDeliveryRouting({
    requestId: context.requestId,
    spaceId: context.spaceId,
    channelId: context.channelId,
    messageId,
  });
}

export async function postgresMessageLiveRecipientUserIds(
  env: Env,
  channelId: string,
  dependencies: PostgresMessageDependencies = {},
) {
  const context = await postgresMessageBackgroundContext(env, channelId, "message-live-recipients", dependencies);
  return context.messages.liveRecipientUserIds({
    requestId: context.requestId, spaceId: context.spaceId, channelId: context.channelId,
  });
}

export async function postgresMessageRepairSenderSnapshots(
  env: Env,
  input: Record<string, unknown>,
  dependencies: PostgresMessageDependencies = {},
): Promise<Record<string, unknown>> {
  const repairContext = await postgresMessageCommandContextFromInput(
    env, input, "message-sender-repair", dependencies,
  );
  const { commandId, actor, requestId, channelId, spaceId, messages } = repairContext;
  if (actor.kind !== "user") throw new MessageAuthorityError(
    "invalid_command", 400, "Repair principal is invalid",
  );
  const identity = record(input.identity, "identity");
  const agentId = bounded(identity.agentId, "identity.agentId");
  const agentName = bounded(identity.agentName, "identity.agentName");
  const instanceId = bounded(identity.instanceId, "identity.instanceId");
  const channelInstanceId = bounded(identity.channelInstanceId, "identity.channelInstanceId");
  const ownerUserId = bounded(identity.userId, "identity.userId");
  if (!agentId.startsWith(`agent:${ownerUserId}:`) ||
      !Array.isArray(input.repairs) || input.repairs.length < 1 || input.repairs.length > 64) {
    throw new MessageAuthorityError("invalid_command", 400, "Agent identity repair is invalid");
  }
  const requested = input.repairs.map((entry, index) => {
    const repair = record(entry, `repairs[${index}]`);
    return {
      messageId: bounded(repair.messageId, `repairs[${index}].messageId`),
      expectedRecordDigest: bounded(
        repair.expectedRecordDigest, `repairs[${index}].expectedRecordDigest`,
      ),
    };
  });
  if (new Set(requested.map((entry) => entry.messageId)).size !== requested.length) {
    throw new MessageAuthorityError("invalid_command", 400, "Repair message ids must be unique");
  }
  const instanceLabel = `${agentName}:${channelInstanceId}`;
  const prepared = [];
  for (const repair of requested) {
    const candidate = await messages.senderRepairCandidate({
      requestId, spaceId, channelId, messageId: repair.messageId, principal: actor,
    });
    if (candidate.senderKind !== "agent" || candidate.senderId !== agentId ||
        candidate.recordDigest !== repair.expectedRecordDigest ||
        typeof candidate.payloadBundleBase64 !== "string") {
      throw new MessageAuthorityError(
        "sender_snapshot_repair_conflict", 409,
        "Agent sender repair no longer matches canonical message authority",
      );
    }
    const bundle = decodeRelayV2MessagePayloadBundle(
      base64UrlDecodeBytes(candidate.payloadBundleBase64),
    );
    const existing = bundle.senderSnapshot;
    const compatible = (key: string, expected: string, unknownAllowed = false) => {
      const current = existing[key];
      return current === undefined || current === expected ||
        (unknownAllowed && current === "Unknown agent");
    };
    if (!compatible("identityId", agentId) || !compatible("agentId", agentId) ||
        !compatible("kind", "agent") || !compatible("agentName", agentName, true) ||
        !compatible("name", agentName, true) || !compatible("instanceId", instanceId) ||
        !compatible("channelInstanceId", channelInstanceId) ||
        !compatible("instanceLabel", instanceLabel) || !compatible("label", instanceLabel, true) ||
        !compatible("userId", ownerUserId)) {
      throw new MessageAuthorityError(
        "sender_snapshot_repair_conflict", 409,
        "Agent sender snapshot already carries different identity facts",
      );
    }
    const nextVersion = Number(candidate.entityVersion) + 1;
    const next = await prepareRelayV2MessageRecord({
      messageId: repair.messageId,
      channelId,
      timelineSequence: Number(candidate.sequence),
      senderKind: "agent",
      senderId: agentId,
      messageKind: String(candidate.messageKind),
      payloadSchemaVersion: RELAY_V2_MESSAGE_PAYLOAD_SCHEMA_VERSION,
      entityVersion: nextVersion,
      sentAt: String(candidate.sentAt),
      ...(candidate.editedAt ? { editedAt: String(candidate.editedAt) } : {}),
      body: bundle.body,
      senderSnapshot: {
        ...existing, identityId: agentId, kind: "agent", agentId, agentName, name: agentName,
        label: instanceLabel, userId: ownerUserId, instanceId, channelInstanceId, instanceLabel,
      },
      ...(Object.prototype.hasOwnProperty.call(bundle, "residual")
        ? { residual: bundle.residual! } : {}),
    });
    prepared.push({
      messageId: repair.messageId,
      expectedEntityVersion: Number(candidate.entityVersion),
      expectedRecordDigest: repair.expectedRecordDigest,
      prepared: postgresPreparedMessage(next),
    });
  }
  const requestDigest = await sha256Hex(canonicalJson({
    commandId, channelId,
    identity: { agentId, agentName, instanceId, channelInstanceId, userId: ownerUserId },
    repairs: requested,
  }));
  return messages.repairSenderSnapshots({
    requestId, commandId, requestDigest, spaceId, channelId, principal: actor,
    agentId, repairedAt: new Date().toISOString(), repairs: prepared,
  });
}

const MESSAGE_SEARCH_RESULT_LIMIT = 80;
const MESSAGE_SEARCH_CANDIDATE_PAGE = 1_000;
const MESSAGE_SEARCH_FIRST_BUDGET = 5_000;
const MESSAGE_SEARCH_RESUME_BUDGET = 20_000;
const MESSAGE_SEARCH_SNIPPET_CHARS = 160;

function searchSnippet(text: string, at: number, length: number): string {
  const half = Math.floor((MESSAGE_SEARCH_SNIPPET_CHARS - length) / 2);
  const start = Math.max(0, at - Math.max(half, 0));
  const end = Math.min(text.length, start + MESSAGE_SEARCH_SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

function searchSenderLabel(snapshot: Record<string, unknown> | undefined): string {
  for (const key of ["label", "name", "agentName"]) {
    const value = snapshot?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * One candidate's hit for a lower-cased needle: body, then an attachment name,
 * then the sender label. An empty needle matches every message (a filter-only
 * search); `agentName` keeps only an Agent's messages sent under that name.
 */
export function matchMessageSearchCandidate(
  candidate: MessageSearchCandidate,
  needle: string,
  agentName?: string,
): MessageSearchHit | null {
  const bundle = candidate.payloadBundleBase64
    ? decodeRelayV2MessagePayloadBundle(base64UrlDecodeBytes(candidate.payloadBundleBase64))
    : undefined;
  const senderLabel = searchSenderLabel(bundle?.senderSnapshot);
  if (agentName !== undefined && !searchAgentNameMatches(bundle?.senderSnapshot, agentName)) return null;
  const body = bundle?.body ?? candidate.legacyBody ?? "";
  const bodyAt = body.toLocaleLowerCase().indexOf(needle);
  const attachmentName = bodyAt < 0
    ? (candidate.attachmentNames ?? []).find((name) => name.toLocaleLowerCase().includes(needle)) ?? ""
    : "";
  const senderAt = bodyAt < 0 && !attachmentName
    ? senderLabel.toLocaleLowerCase().indexOf(needle) : -1;
  if (bodyAt < 0 && !attachmentName && senderAt < 0) return null;
  const field = bodyAt >= 0 ? "body" : attachmentName ? "attachment" : "sender";
  return {
    kind: "message",
    entityId: candidate.messageId,
    entityVersion: candidate.entityVersion,
    matchTier: "verified_substring",
    field,
    fieldPriority: field === "body" ? 0 : field === "attachment" ? 1 : 2,
    searchRankSeq: candidate.searchRankSequence,
    snippet: bodyAt >= 0 ? searchSnippet(body, bodyAt, needle.length) : attachmentName || searchSnippet(body, 0, 0),
    channelId: candidate.channelId,
    messageId: candidate.messageId,
    timelineSequence: candidate.timelineSequence,
    senderLabel,
    sentAt: candidate.sentAt,
  };
}

/** An Agent's messages carry its name in the sender snapshot; its Instances do not share an author id. */
function searchAgentNameMatches(snapshot: Record<string, unknown> | undefined, agentName: string): boolean {
  const wanted = agentName.toLocaleLowerCase();
  return ["agentName", "name"].some((key) => {
    const value = snapshot?.[key];
    return typeof value === "string" && value.toLocaleLowerCase() === wanted;
  });
}

/**
 * Searches the newest live messages of every Channel the reader may read, in
 * search-rank order, up to a bounded candidate budget. A page that spends its
 * budget before filling its results returns a resume token for the next scan.
 */
export async function postgresMessageSearch(
  env: Env,
  input: {
    spaceId: string; query: string; resumeToken?: string; principal: AuthorityPrincipal;
    /** Only this Channel and its threads. */
    channelId?: string;
    /** Only this author's messages: a person by user id, an Agent by name. */
    from?: { kind: "user"; userId: string } | { kind: "agent"; name: string };
  },
  dependencies: PostgresMessageDependencies = {},
): Promise<MessageSearchPage> {
  const needle = input.query.trim().toLocaleLowerCase();
  // A filter alone is a search: every message in the Channel, or by the author.
  if ((!needle && !input.channelId && !input.from) || needle.length > 200) {
    throw new MessageAuthorityError("invalid_request", 400, "Search query is invalid");
  }
  const agentName = input.from?.kind === "agent" ? input.from.name : undefined;
  const repository = new PostgresMessageRepository(
    dependencies.database ?? database(env), dependencies.requestScoped === true,
  );
  const budget = input.resumeToken ? MESSAGE_SEARCH_RESUME_BUDGET : MESSAGE_SEARCH_FIRST_BUDGET;
  let beforeRank = input.resumeToken;
  let scanned = 0;
  const results: MessageSearchHit[] = [];
  while (scanned < budget && results.length < MESSAGE_SEARCH_RESULT_LIMIT) {
    const requested = Math.min(MESSAGE_SEARCH_CANDIDATE_PAGE, budget - scanned);
    const candidates = await repository.searchCandidates({
      requestId: `message-search:${crypto.randomUUID()}`,
      spaceId: bounded(input.spaceId, "spaceId"),
      principal: principal(input.principal),
      beforeRank,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.from ? { authorKind: input.from.kind } : {}),
      ...(input.from?.kind === "user" ? { authorId: input.from.userId } : {}),
      limit: requested,
    });
    for (const candidate of candidates) {
      scanned += 1;
      beforeRank = candidate.searchRankSequence;
      const hit = matchMessageSearchCandidate(candidate, needle, agentName);
      if (hit) results.push(hit);
      if (results.length >= MESSAGE_SEARCH_RESULT_LIMIT) break;
    }
    // A short page reached the oldest readable message: nothing is left to scan.
    if (results.length < MESSAGE_SEARCH_RESULT_LIMIT && candidates.length < requested) {
      return { results, execution: "proven" };
    }
  }
  return { results, execution: "budget_exhausted", ...(beforeRank ? { resumeToken: beforeRank } : {}) };
}
