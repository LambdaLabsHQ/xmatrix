import type { Context, Hono } from "hono";
import { DURABLE_OBJECT_RETRY_AFTER_SECONDS } from "./durable-object-failure";
import { runtimeRepository } from "./runtime";
import { AGENT_RUN_PERMISSION_CHANNEL_ATTACHMENTS_WRITE, agentSendSubmissionCanonical, callerMessageMetadata, messagePublicationEvidence, sha256Hex } from "@xmatrix/protocol";
import type { ChannelAppMention, ChannelAttachment } from "@xmatrix/protocol";
import type { Env } from "./types";
import { LIVE_RUN_LAUNCH_FIELDS, liveRunIsAdmitted, snapshotLiveRunFromProductGateway } from "./live-run-admission";
import { type AuthUser } from "./auth";
import { agentMessagePresentationForLiveBinding, loadLiveAgentPresenceFromRuntime } from "./runtime-transport/agent-presence-snapshot";
import { runtimeCellsForChannel } from "./runtime-transport/runtime-route-directory-delivery";
import { agentRunDelegationFailure, requireAgentRunChannelDelegation } from "./agent-run-channel-delegation";
import { dispatchProductMessagePostCommit, productMessageControlFinishesBeforeResponse } from "./product-message-post-commit";
import { AgentLaunchHandoverUnavailable } from "./agent-launch-coordinator-wake";
import { productMessageSenderPresentation } from "./message-sender-presentation";
import { crossChannelReplyOrigin } from "./product-cross-channel-reply";
import { messageMutationActor } from "./agent-run-channel-delegation";
import {
  requireAuth,
  requireAgentRunPermission,
  actorUserId,
  productCommandId,
  channelAppMentionsForPublicMessage,
  jsonErrors,
  requestErrorResponse,
} from "./index-shared";
import {
  appendChannelMessage,
  channelMessageCommand,
  channelMessageResponse,
  channelMessageResult,
  scheduleChannelLiveDelivery,
} from "./channel-messages";

type MessageRouteContext = Context<{ Bindings: Env }, "/api/channels/:channelId/messages/:messageId/*">;

/**
 * The authenticated actor mutating one message.
 */
async function messageMutationContext(c: MessageRouteContext) {
  const channelId = c.req.param("channelId");
  const messageId = c.req.param("messageId");
  const authUser = await requireAuth(c.req.raw, c.env);
  const actor = await messageMutationActor(c.env, authUser, channelId);
  if (actor instanceof Response) return actor;
  return { ...actor, authUser, channelId, messageId };
}

function mutationMessageResponse(c: MessageRouteContext,
  mutation: Exclude<Awaited<ReturnType<typeof messageMutationContext>>, Response>,
  receipt: Record<string, unknown>, content: Record<string, unknown>): Response {
  const { messageId, channelId, from } = mutation;
  return c.json({ ok: true, message: { messageId, channelId, sequence: receipt.sequence, from, ...content } });
}

/** Channel message append, attachment, reaction, edit and delete routes. */
export function registerChannelMessageRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/channels/:channelId/messages", async (c) => {
    let authUser: AuthUser;
    try {
      authUser = await requireAuth(c.req.raw, c.env);
    } catch (error) {
      return requestErrorResponse(c, error);
    }

    try {
      const channelId = c.req.param("channelId");
      const rawBody = await c.req.json().catch(() => ({}));
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        return c.json({ error: "Message request must be a JSON object" }, 400);
      }
      const allowedMessageFields = new Set([
        "invocationSelections",
        "finalReplyExecutionId",
        "appMentions",
        "attachments",
        "body",
        "clientMessageId",
        "metadata",
        "replyToMessageId",
        "senderAgentId",
        "senderAgentInstanceId",
        "senderAgentName",
        "senderExecutionKey",
        "senderRunId",
      ]);
      const unexpectedMessageFields = Object.keys(rawBody).filter(
        (field) => !allowedMessageFields.has(field),
      );
      if (unexpectedMessageFields.length > 0) {
        return c.json(
          { error: `Message request contains unexpected fields: ${unexpectedMessageFields.join(", ")}` },
          400,
        );
      }
      const body = rawBody as {
        invocationSelections?: unknown;
        finalReplyExecutionId?: string;
        body?: string;
        clientMessageId?: string;
        replyToMessageId?: string;
        appMentions?: ChannelAppMention[];
        metadata?: Record<string, unknown>;
        attachments?: unknown;
        senderAgentId?: string;
        senderAgentName?: string;
        senderAgentInstanceId?: string;
        senderRunId?: string;
        senderExecutionKey?: string;
      };
      const message = channelAppMentionsForPublicMessage(body.body, body.appMentions);
      const principal = authUser.agentRun;
      if (body.invocationSelections !== undefined) {
        if (principal || body.senderAgentId || body.senderAgentInstanceId) return c.json({
          error: "Agent invocation selections require a Human caller", code: "invocation_selection_forbidden",
        }, 403);
      }
      if (body.finalReplyExecutionId !== undefined) {
        if (!principal) return c.json({ error: "Final reply requires an authenticated Agent Run" }, 403);
        if (typeof body.finalReplyExecutionId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(body.finalReplyExecutionId)) {
          return c.json({ error: "Final reply requires a canonical execution UUID" }, 400);
        }
      }
      // Throws unless this Run holds the attachment-write permission. Under the
      // PostgreSQL authority the append itself proves the exact Run and its
      // write access to this Channel, exactly as for a text send, so a Run may
      // attach files wherever it may write; elsewhere it stays birth-pinned.
      if (body.attachments !== undefined && principal) {
        await requireAgentRunPermission(
          c.env,
          authUser,
          AGENT_RUN_PERMISSION_CHANNEL_ATTACHMENTS_WRITE,
          undefined,
        );
      }
      if (
        principal &&
        ((body.senderAgentId && body.senderAgentId !== principal.agentId) ||
          (body.senderRunId && body.senderRunId !== principal.runId) ||
          (body.senderExecutionKey && body.senderExecutionKey !== principal.executionKey) ||
          (principal.instanceId && body.senderAgentInstanceId &&
            body.senderAgentInstanceId !== principal.instanceId))
      ) {
        return c.json({ error: "Sender identity does not match the Agent run token" }, 403);
      }
        const messageId = body.clientMessageId?.trim() || crypto.randomUUID();
        // Room allowed a human owner to attribute a post to a live Agent Run when
        // the host session is gone (daemon run-scoped birth-channel send).
        let attributedAgent: {
          agentId: string;
          agentName: string;
          runId: string;
          executionKey: string;
          /** The live Run's Instance. An Agent message is never committed without it. */
          instanceId: string;
        } | undefined;
        if (
          !principal &&
          typeof body.senderAgentId === "string" && body.senderAgentId.trim() &&
          typeof body.senderRunId === "string" && body.senderRunId.trim() &&
          typeof body.senderExecutionKey === "string" && body.senderExecutionKey.trim()
        ) {
          // Room fail-closed: do not distinguish missing vs mismatched run credentials.
          const runResult = await runtimeRepository(c.env).getRun({ requestId: crypto.randomUUID(),
            runId: body.senderRunId.trim(), actorUserId: authUser.id }).catch(() => undefined);
          if (!runResult) {
            return c.json({ error: "Sender identity does not match a live Agent run" }, 403);
          }
          const run = runResult.run as Record<string, unknown>;
          if (!liveRunIsAdmitted(
            snapshotLiveRunFromProductGateway(run),
            {
              agentId: body.senderAgentId.trim(),
              channelId,
              executionKey: body.senderExecutionKey.trim(),
            },
            LIVE_RUN_LAUNCH_FIELDS,
          )) {
            return c.json({ error: "Sender identity does not match a live Agent run" }, 403);
          }
          /* An Agent message names its exact live Instance or it is not
             committed. Two live Instances of one Agent are separate
             participants, and a reader asking "did I write this?" — the
             delivery path's own-echo filter above all — can only answer for
             the whole Agent when the Instance is missing, which makes those
             two Instances deaf to each other. The Run was just admitted as
             live, so its Instance is the authoritative answer here; the
             signed-principal path enforces the same rule below. */
          const attributedInstanceId = typeof run.instanceId === "string"
            ? run.instanceId.trim()
            : "";
          if (!attributedInstanceId) {
            return c.json(
              { error: "Agent message requires its exact live Instance identity" },
              403,
            );
          }
          if (typeof body.senderAgentInstanceId === "string" &&
              body.senderAgentInstanceId.trim() &&
              body.senderAgentInstanceId.trim() !== attributedInstanceId) {
            return c.json({ error: "Sender identity does not match a live Agent run" }, 403);
          }
          // A Run's actor is its Instance; PostgreSQL prepareAppend loads its
          // registration identity with the append.
          const runMetadata = run.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
            ? run.metadata as Record<string, unknown> : {};
          attributedAgent = {
            instanceId: attributedInstanceId,
            agentId: attributedInstanceId,
            agentName: typeof body.senderAgentName === "string" && body.senderAgentName.trim()
              ? body.senderAgentName.trim()
              : typeof runMetadata.agentName === "string" && runMetadata.agentName.trim()
                ? runMetadata.agentName.trim() : attributedInstanceId,
            runId: body.senderRunId.trim(),
            executionKey: body.senderExecutionKey.trim(),
          };
        }
        const appendPrincipal = principal
          ? { kind: "agent" as const, id: principal.agentId }
          : attributedAgent
            ? { kind: "agent" as const, id: attributedAgent.agentId }
            : { kind: "user" as const, id: authUser.id };
        const agentInstanceId = principal
          ? principal.instanceId || body.senderAgentInstanceId?.trim()
          : undefined;
        if (principal && !agentInstanceId) {
          return c.json(
            { error: "Agent message requires its exact live Instance identity" },
            403,
          );
        }
        /* The signed Run principal fixes immutable identity; PostgreSQL
           prepareAppend validates the current Run/Instance and loads both the
           exact Profile identity and that Instance's presentation in the same
           transaction as authorization and the observed head — so the row,
           not this read, is now the header's source, and it wins key by key.
           This read stays as the gap-filler until the row is observed carrying
           presentation in production. Dropping a presentation read because a
           new source *should* cover it is precisely how every header committed
           bare for two weeks; the binding push-down already made it cheap. */
        const liveAgentSessions = principal
          ? (await Promise.all((await runtimeCellsForChannel(c.env, channelId)).map((cell) =>
              loadLiveAgentPresenceFromRuntime(cell, c.req.url, {
                agentId: principal.agentId,
                runId: principal.runId,
                instanceId: agentInstanceId!,
                channelId,
              })))).flat()
          : [];
        const liveMessagePresentation = principal
          ? agentMessagePresentationForLiveBinding(liveAgentSessions, {
              agentId: principal.agentId,
              runId: principal.runId,
              instanceId: agentInstanceId!,
              channelId,
            })
          : undefined;
        const trustedAgentSenderPresentation = principal
          ? liveMessagePresentation ?? {
              identityId: principal.agentId, kind: "agent", agentId: principal.agentId,
              label: principal.agentName, name: principal.agentName, agentName: principal.agentName,
              email: "",
              userId: principal.ownerUserId, instanceId: agentInstanceId!,
            }
          : undefined;
        // Keys only the Hub writes (provenance, activity, relayed-reply origin)
        // never come from the caller: a sender could otherwise pass a message
        // off as a system notice that no Agent is woken by.
        const appMetadata = {
          ...callerMessageMetadata(body.metadata),
          ...(message.appMentions?.length ? { appMentions: message.appMentions } : {}),
        };
        const residual = {
          ...(body.replyToMessageId ? { replyToMessageId: body.replyToMessageId } : {}),
          ...(Object.keys(appMetadata).length > 0 ? { appMetadata } : {}),
        };
        const appendCommand = {
          commandId: productCommandId(c.req.raw, "append-message", messageId),
          messageId,
          channelId,
          body: message.body,
          ...(body.invocationSelections === undefined ? {} : { invocationSelections: body.invocationSelections }),
          ...(body.finalReplyExecutionId === undefined ? {} : { finalReplyExecutionId: body.finalReplyExecutionId }),
          principal: appendPrincipal,
          senderSnapshot: principal
            ? trustedAgentSenderPresentation
            : attributedAgent
              ? {
                  identityId: attributedAgent.agentId,
                  kind: "agent",
                  agentId: attributedAgent.agentId,
                  label: attributedAgent.agentName,
                  name: attributedAgent.agentName,
                  agentName: attributedAgent.agentName,
                  userId: authUser.id,
                  email: authUser.email,
                  instanceId: attributedAgent.instanceId,
                }
              : {
                  identityId: `user:${authUser.id}`,
                  kind: "user",
                  userId: authUser.id,
                  label: authUser.name || authUser.email || authUser.id,
                  name: authUser.name || authUser.email || authUser.id,
                  email: authUser.email,
                  avatarUrl: authUser.avatarUrl,
                },
          ...(principal ? {
            agentRunProof: {
              runId: principal.runId,
              executionKey: principal.executionKey,
              instanceId: agentInstanceId!,
            },
          } : {}),
          ...(Object.keys(residual).length > 0 ? { residual } : {}),
          /* Every sender binds its attachments in the append itself. Binding an
             Agent's afterwards left the frame pushed at commit attachment-free,
             so an image an Agent sent never reached a Human client live. */
          ...(body.attachments === undefined ? {} : { attachments: body.attachments }),
        };
        const rawAgentSubmission = principal && agentInstanceId
          ? agentSendSubmissionCanonical({ channelId, messageId, agentId: principal.agentId,
              runId: principal.runId, instanceId: agentInstanceId }, rawBody)
          : null;
        const agentSendEvidence = rawAgentSubmission === null ? undefined : {
          agentSendFingerprint: await sha256Hex(rawAgentSubmission),
        };
        const result = await channelMessageResult(() =>
          appendChannelMessage(c.env, channelId, appendCommand, agentSendEvidence));
        if (!result.ok) return result.response;
        const committed = result.payload;
        const committedSenderSnapshot = committed.senderSnapshot &&
            typeof committed.senderSnapshot === "object" &&
            !Array.isArray(committed.senderSnapshot)
          ? committed.senderSnapshot as Record<string, unknown>
          : undefined;
        const committedSender = committedSenderSnapshot
          ? productMessageSenderPresentation(
              committedSenderSnapshot,
              appendPrincipal.kind,
              appendPrincipal.id,
            )
          : undefined;
        const committedAttachments = Array.isArray(committed.attachments)
          ? committed.attachments as ChannelAttachment[]
          : undefined;
        const senderAgentId = principal?.agentId || attributedAgent?.agentId;
        const senderAgentName = principal?.agentName || attributedAgent?.agentName;
        const sender = {
          identityId: senderAgentId || `user:${authUser.id}`,
          kind: senderAgentId ? "agent" : "user",
          label: senderAgentName || authUser.name || authUser.email,
          userId: actorUserId(authUser),
          email: authUser.email,
        };
        scheduleChannelLiveDelivery(
          c.env,
          (task) => c.executionCtx.waitUntil(task),
          channelId,
          {
            channelId,
            messageId,
            sequence: Number(committed.sequence),
            ...messagePublicationEvidence(committed),
            body: message.body ?? "",
            from: committedSender || sender,
            sentAt: committed.committedAt,
            clientMessageId: messageId,
            ...(body.replyToMessageId ? { replyToMessageId: body.replyToMessageId } : {}),
            ...(Object.keys(appMetadata).length > 0 ? { metadata: appMetadata } : {}),
            ...(committedAttachments?.length ? { attachments: committedAttachments } : {}),
          },
        );
        if (typeof message.body === "string") {
          // The message payload's sentAt predates validation and the database
          // transaction. Launch latency starts after the durable append returns,
          // so do not mislabel request-start time as commit time.
          const postCommitAt = new Date().toISOString();
          const postCommit = dispatchProductMessagePostCommit({
            env: c.env,
            channelId,
            messageId,
            body: message.body,
            actorUserId: actorUserId(authUser),
            senderKind: appendPrincipal.kind,
            senderId: appendPrincipal.id,
            committedAt: postCommitAt,
            scheduleBackground: (task) => { try { c.executionCtx.waitUntil(task); } catch { /* no ExecutionContext outside Workers */ } },
            ...((principal?.runId || attributedAgent?.runId)
              ? { senderRunId: principal?.runId || attributedAgent?.runId } : {}),
            sequence: Number(committed.sequence),
            ...(committedAttachments?.length ? { attachments: committedAttachments } : {}),
            ...(crossChannelReplyOrigin(committed.replyOrigin)
              ? { replyOrigin: crossChannelReplyOrigin(committed.replyOrigin) } : {}),
          });
          // waitUntil is cancelled after the response and the summon then vanishes.
          if (productMessageControlFinishesBeforeResponse(message.body)) {
            try { await postCommit; }
            catch (error) {
              if (!(error instanceof AgentLaunchHandoverUnavailable)) throw error;
              // The message is committed; its retry re-runs the same launch
              // idempotently and hands it to the Channel coordinator.
              return c.json({ error: error.message, code: error.code, retryable: true }, 503,
                { "retry-after": String(DURABLE_OBJECT_RETRY_AFTER_SECONDS) });
            }
          } else c.executionCtx.waitUntil(postCommit.catch(() => undefined));
        }
        return c.json({
          message: {
            messageId,
            channelId,
            sequence: committed.sequence,
            ...messagePublicationEvidence(committed),
            changeSeq: committed.changeSeq,
            clientMessageId: body.clientMessageId?.trim() || undefined,
            from: committedSender || {
              ...sender,
              ...(senderAgentName ? { agentName: senderAgentName } : {}),
              ...(!senderAgentId && authUser.avatarUrl ? { avatarUrl: authUser.avatarUrl } : {}),
            },
            body: message.body ?? "",
            sentAt: committed.committedAt,
            replyToMessageId: body.replyToMessageId,
            appMentions: message.appMentions,
            metadata: body.metadata,
            ...(committedAttachments?.length ? { attachments: committedAttachments } : {}),
          },
        });
    } catch (error) {
      return requestErrorResponse(c, error);
    }
  });
  app.post("/api/channels/:channelId/messages/:messageId/attachments", async (c) => {
    try {
      const authUser = await requireAuth(c.req.raw, c.env);
      const channelId = c.req.param("channelId");
      const messageId = c.req.param("messageId");
      // A Run attaches files wherever it may write, as for a send.
      const runPrincipal = authUser.agentRun
        ? await requireAgentRunPermission(
            c.env,
            authUser,
            AGENT_RUN_PERMISSION_CHANNEL_ATTACHMENTS_WRITE,
          )
        : undefined;
      if (runPrincipal && channelId !== runPrincipal.channelId) {
        await requireAgentRunChannelDelegation(c.env, runPrincipal, [channelId]);
      }
      const body = (await c.req.json().catch(() => ({}))) as {
        attachments?: unknown;
      };
      const command = {
          commandId: productCommandId(
            c.req.raw,
            "message-attachment",
            `${messageId}:${runPrincipal?.agentId || authUser.id}`,
          ),
          channelId,
          messageId,
          attachments: body.attachments,
          actorUserId: actorUserId(authUser),
          principal: runPrincipal
            ? { kind: "agent", id: runPrincipal.agentId }
            : { kind: "user", id: authUser.id },
        };
      return channelMessageResponse(() => channelMessageCommand(c.env, channelId, "message-attachment", command));
    } catch (error) {
      const delegationFailure = agentRunDelegationFailure(error);
      if (delegationFailure) return delegationFailure;
      return requestErrorResponse(c, error);
    }
  });
  app.post("/api/channels/:channelId/messages/:messageId/reactions", (c) => jsonErrors(c, async () => {
    const mutation = await messageMutationContext(c);
    if (mutation instanceof Response) return mutation;
    const { authUser, channelId, messageId, run, principal } = mutation;
    const body = (await c.req.json().catch(() => ({}))) as { emoji?: string };
    const command = {
      commandId: productCommandId(c.req.raw, "message-reaction", `${messageId}:${principal.id}:${body.emoji || ""}`),
      channelId, messageId, emoji: body.emoji,
      reactorLabel: run ? run.agentName : authUser.name || authUser.email,
      ...(run ? {} : { actorUserId: authUser.id }), principal,
    };
    return channelMessageResponse(() => channelMessageCommand(c.env, channelId, "message-reaction", command));
  }));
  app.patch("/api/channels/:channelId/messages/:messageId", (c) => jsonErrors(c, async () => {
    const mutation = await messageMutationContext(c);
    if (mutation instanceof Response) return mutation;
    const { channelId, messageId, principal } = mutation;
    const body = (await c.req.json().catch(() => ({}))) as { body?: string };
    const command = {
        commandId: productCommandId(c.req.raw, "edit-message"),
        messageId,
        channelId,
        body: body.body,
        principal,
      };
    const result = await channelMessageResult(() => channelMessageCommand(c.env, channelId, "edit-message", command));
    if (!result.ok) return result.response;
    return mutationMessageResponse(c, mutation, result.payload, {
      body: typeof body.body === "string" ? body.body.trim() : "",
      sentAt: result.payload.editedAt,
      editedAt: result.payload.editedAt,
    });
  }));
  app.delete("/api/channels/:channelId/messages/:messageId", (c) => jsonErrors(c, async () => {
    const mutation = await messageMutationContext(c);
    if (mutation instanceof Response) return mutation;
    const { channelId, messageId, principal } = mutation;
    const permanent = c.req.query("permanent") === "true";
    const commandKind = permanent ? "delete-message" : "recall-message";
    const command = {
        commandId: productCommandId(c.req.raw, commandKind),
        messageId,
        channelId,
        principal,
      };
    const result = await channelMessageResult(() => channelMessageCommand(c.env, channelId, commandKind, command));
    if (!result.ok) return result.response;
    return mutationMessageResponse(c, mutation, result.payload, {
      body: "",
      sentAt: result.payload.committedAt,
      ...(permanent
        ? { deletedAt: result.payload.committedAt }
        : { recalledAt: result.payload.committedAt }),
    });
  }));
}
