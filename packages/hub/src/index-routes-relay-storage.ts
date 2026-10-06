import type { Context, Hono } from "hono";
import { relayResponse } from "./private-response";
import type { Env } from "./types";
import { postgresMessageAttachmentAuthorityRequest } from "./postgres-message-attachment-authority";
import { agentRunDelegationDenied } from "./agent-run-channel-delegation";
import {
  RELAY_R2_BLOB_REF_PATH,
  RELAY_R2_BLOB_REF_RELEASE_PATH,
  RELAY_R2_UPLOAD_INTENT_PATH,
  RELAY_R2_UPLOAD_PREFIX,
  handleRelayR2BlobRefCommit,
  handleRelayR2BlobRefRelease,
  handleRelayR2UploadIntentCreate,
  handleRelayR2UploadPut,
  handleRelayR2UploadVerify,
  relayContentRepository,
} from "./relay-r2-upload-private-api";
import {
  handleRelayV2MessageAttachmentProductMedia,
  RELAY_V2_MESSAGE_ATTACHMENT_PRODUCT_MEDIA_PATH,
} from "./relay-r2-private-api";
import {
  requireAuth,
  privateUploadAuthorization,
  actorUserId,
  requireAdmin,
  relayR2PrivateErrorResponse,
  requestErrorStatus,
  relayChannelIdFromRequest,
  relayVisibilityScopeIdFromRequest,
  requireBlobVisibilityScope,
  getRelayRuntime,
} from "./index-shared";

type RelayStorageContext = Context<{ Bindings: Env }>;

/** Hono drops path typing through a shared handler; the route pattern still guarantees it. */
function pathParam(c: RelayStorageContext, name: "intentId" | "visibilityScopeId"): string {
  return c.req.param(name) ?? "";
}

function payloadBucket(env: Env): R2Bucket {
  if (!env.RELAY_PAYLOAD_BUCKET) throw new Error("RELAY_PAYLOAD_BUCKET is not configured");
  return env.RELAY_PAYLOAD_BUCKET;
}

/** Every R2 route answers its failures through the private-API error contract. */
function relayR2Route(handler: (c: RelayStorageContext) => Promise<Response>) {
  return async (c: RelayStorageContext): Promise<Response> => {
    try {
      return await handler(c);
    } catch (error) {
      return relayR2PrivateErrorResponse(error);
    }
  };
}

/** The upload principal, admitted only while the product authority is live. */
async function uploadAuthorization(c: RelayStorageContext, visibilityScopeId?: string) {
  const authorization = await privateUploadAuthorization(
    c.env, await requireAuth(c.req.raw, c.env), visibilityScopeId,
  );
  return authorization;
}

/** The content authority for a request naming its blob visibility scope, which must be well formed. */
function scopedContent(env: Env, visibilityScopeId: string) {
  requireBlobVisibilityScope(visibilityScopeId);
  return relayContentRepository(env);
}

/** A route's own path scope binds the upload unless the principal is already scoped. */
async function scopedUploadAuthorization(
  c: RelayStorageContext,
  visibilityScopeId: string,
  authorizeScope: boolean,
) {
  const authorization = await uploadAuthorization(c, authorizeScope ? visibilityScopeId : undefined);
  return {
    ...authorization,
    expectedScopeId: authorization.expectedScopeId ?? visibilityScopeId,
    bucket: payloadBucket(c.env),
    content: scopedContent(c.env, visibilityScopeId),
  };
}

/** Admin pass-through of an internal status read, never cached. */
async function adminInternalStatus(
  c: RelayStorageContext,
  host: (env: Env) => { fetch(request: Request): Promise<Response> },
  path: string,
  errorHeaders?: Record<string, string>,
): Promise<Response> {
  try {
    requireAdmin(c.req.raw, c.env);
    const response = await host(c.env).fetch(new Request(new URL(path, c.req.url), { method: "GET" }));
    return relayResponse(response, { "cache-control": "no-store" });
  } catch (error) {
    return c.json({ error: (error as Error).message }, requestErrorStatus(error), errorHeaders);
  }
}

/** Relay v2 capability, R2 storage and relay administration routes. */
export function registerRelayStorageRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(RELAY_V2_MESSAGE_ATTACHMENT_PRODUCT_MEDIA_PATH, relayR2Route(async (c) => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const bucket = payloadBucket(c.env);
    const run = authUser.agentRun;
    const requestedChannelId = await relayChannelIdFromRequest(c.req.raw);
    // A Run reads attachments wherever it may act as its owner, the same
    // proof that let it post there; elsewhere it stays bound to its birth
    // Channel, which still serves a thread's parent-channel root message.
    const authorityChannelId = run && requestedChannelId !== run.channelId &&
        await agentRunDelegationDenied(c.env, run, [requestedChannelId])
      ? run.channelId
      : requestedChannelId;
    return handleRelayV2MessageAttachmentProductMedia({
      request: c.req.raw,
      userId: actorUserId(authUser),
      ...(run ? { requiredChannelId: authorityChannelId } : {}),
      attachmentAuthority: (input) => postgresMessageAttachmentAuthorityRequest(c.env, input),
      bucket,
    });
  }));
  app.post(RELAY_R2_UPLOAD_INTENT_PATH, relayR2Route(async (c) => {
    const visibilityScopeId = await relayVisibilityScopeIdFromRequest(c.req.raw);
    return handleRelayR2UploadIntentCreate({
      request: c.req.raw,
      ...await uploadAuthorization(c, visibilityScopeId),
      content: scopedContent(c.env, visibilityScopeId),
    });
  }));
  for (const mode of ["direct", "staging"] as const) {
    const path = `${RELAY_R2_UPLOAD_PREFIX}/:intentId${mode === "staging" ? "/staging" : ""}`;
    app.put(path, relayR2Route(async (c) => handleRelayR2UploadPut({
      request: c.req.raw,
      ...await uploadAuthorization(c),
      intentId: pathParam(c, "intentId"),
      mode,
      now: Date.now(),
      bucket: payloadBucket(c.env),
      content: relayContentRepository(c.env),
    })));
    // Only the direct write submits its path scope to the principal check; a
    // staged write binds the scope as the expected intent scope alone.
    app.put(`${path}/scope/:visibilityScopeId`, relayR2Route(async (c) => handleRelayR2UploadPut({
      request: c.req.raw,
      ...await scopedUploadAuthorization(c, pathParam(c, "visibilityScopeId"), mode === "direct"),
      intentId: pathParam(c, "intentId"), mode, now: Date.now(),
    })));
  }
  app.post(`${RELAY_R2_UPLOAD_PREFIX}/:intentId/verify`, relayR2Route(async (c) => handleRelayR2UploadVerify({
    ...await uploadAuthorization(c),
    intentId: pathParam(c, "intentId"),
    bucket: payloadBucket(c.env),
    content: relayContentRepository(c.env),
  })));
  app.post(`${RELAY_R2_UPLOAD_PREFIX}/:intentId/verify/scope/:visibilityScopeId`, relayR2Route(async (c) =>
    handleRelayR2UploadVerify({
      ...await scopedUploadAuthorization(c, pathParam(c, "visibilityScopeId"), true),
      intentId: pathParam(c, "intentId"),
    })));
  app.post(RELAY_R2_BLOB_REF_PATH, relayR2Route(async (c) => {
    const visibilityScopeId = await relayVisibilityScopeIdFromRequest(c.req.raw);
    return handleRelayR2BlobRefCommit({
      request: c.req.raw,
      ...await uploadAuthorization(c, visibilityScopeId),
      now: Date.now(),
      bucket: payloadBucket(c.env),
      content: scopedContent(c.env, visibilityScopeId),
    });
  }));
  app.post(RELAY_R2_BLOB_REF_RELEASE_PATH, relayR2Route(async (c) => {
    const releaseBody = await c.req.raw.clone().json<Record<string, unknown>>();
    const visibilityScopeId = typeof releaseBody.visibilityScopeId === "string"
      ? releaseBody.visibilityScopeId : undefined;
    const authorization = await uploadAuthorization(c, visibilityScopeId);
    return handleRelayR2BlobRefRelease({
      request: c.req.raw,
      ...authorization,
      expectedScopeId: authorization.expectedScopeId ?? visibilityScopeId,
      content: visibilityScopeId ? scopedContent(c.env, visibilityScopeId) : relayContentRepository(c.env),
    });
  }));
  app.get("/api/admin/relay-runtime-health", (c) =>
    adminInternalStatus(c, getRelayRuntime, "/internal/health"));
}
