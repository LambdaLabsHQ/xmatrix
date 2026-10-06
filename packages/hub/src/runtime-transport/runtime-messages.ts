import { plainRecord } from "@xmatrix/protocol";
import { crossChannelReplyOrigin } from "../product-cross-channel-reply";
import { RuntimeAuthorityOperationError } from "./runtime-operation-failure";
import type { Env } from "../types";
import {
  acknowledgeChannelMessage,
  appendChannelMessage,
  channelMessageHistory,
  publishChannelLiveDelivery,
} from "../channel-messages";
import { productMessageSenderPresentation } from "../message-sender-presentation";
import { dispatchProductMessagePostCommit, productMessageControlFinishesBeforeResponse } from "../product-message-post-commit";
import { AgentLaunchHandoverUnavailable } from "../agent-launch-coordinator-wake";
import type { RuntimeLiveDeliverySelf } from "./runtime-route-directory-delivery";
import { postgresMessageFailure } from "../postgres-message-authority";

/** What a runtime socket's message commands are answered with. */
export interface RuntimeMessages {
  /** Append and, once committed, deliver live and run its post-commit work. */
  append(
    input: Record<string, unknown>,
    context?: Readonly<{ actorUserId?: string; senderRunId?: string }>,
  ): Promise<Record<string, unknown>>;
  acknowledge(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** A runtime socket's message commands, against PostgreSQL; failures carry their classification. */
export function runtimeMessages(
  env: Env,
  scheduleBackground?: (task: Promise<unknown>) => void,
  runtimeSelf?: { cellName: () => string; fetch(request: Request): Promise<Response> },
): RuntimeMessages {
  return {
    async acknowledge(input) {
      const channelId = requiredChannelId("acknowledge-message", input);
      return messageCall("acknowledge-message", () => acknowledgeChannelMessage(env, channelId, input));
    },
    async append(input, context) {
      const channelId = requiredChannelId("append-message", input);
      const payload = await messageCall("append-message", () => appendChannelMessage(env, channelId, input));
      // Runtime append derives stable Agent identity from its authenticated Run.
      // Use the snapshot actually committed by Channel-family for live delivery
      // as well as history; optional Runtime presentation may still be empty.
      const senderSnapshot = isRecord(payload.senderSnapshot)
        ? payload.senderSnapshot
        : isRecord(input.senderSnapshot)
          ? input.senderSnapshot
          : undefined;
      const principal = isRecord(input.principal) ? input.principal : undefined;
      const senderKind = principal?.kind === "agent" ? "agent" : "user";
      const senderId = typeof principal?.id === "string" ? principal.id : "";
      const sequence = Number(payload.sequence);
      const body = typeof input.body === "string" ? input.body : "";
      const sentAt = typeof payload.committedAt === "string"
        ? payload.committedAt
        : new Date().toISOString();
      const from = senderSnapshot
        ? productMessageSenderPresentation(senderSnapshot, senderKind, senderId)
        : { identityId: senderId, kind: senderKind, label: senderId, userId: "" };
      const self: RuntimeLiveDeliverySelf | undefined = runtimeSelf
        ? { cellName: runtimeSelf.cellName(), fetch: request => runtimeSelf.fetch(request) } : undefined;
      const liveDelivery = publishChannelLiveDelivery(env, scheduleBackground ?? (() => {}), channelId, {
          channelId,
          messageId: input.messageId,
          sequence,
          body,
          from,
          sentAt,
          clientMessageId: input.messageId,
          ...(isRecord(input.residual) && typeof input.residual.replyToMessageId === "string"
            ? { replyToMessageId: input.residual.replyToMessageId }
            : {}),
          ...(isRecord(input.residual) && isRecord(input.residual.appMetadata)
            ? { metadata: input.residual.appMetadata }
            : {}),
        }, self)
        .catch((error: unknown) => {
          console.error("Channel family Agent live delivery failed", {
            channelId,
            messageId: input.messageId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      const actorUserId = context?.actorUserId ?? (
        senderSnapshot && typeof senderSnapshot.userId === "string"
          ? senderSnapshot.userId
          : ""
      );
      const postCommit = actorUserId && Number.isSafeInteger(sequence) && sequence > 0
        ? dispatchProductMessagePostCommit({
          env,
          channelId,
          messageId: String(input.messageId),
          body,
          ...(typeof input.messageKind === "string" ? { messageKind: input.messageKind } : {}),
          actorUserId,
          senderKind,
          senderId,
          committedAt: sentAt,
          ...(scheduleBackground ? { scheduleBackground } : {}),
          ...(context?.senderRunId ? { senderRunId: context.senderRunId } : {}),
          sequence,
          ...(crossChannelReplyOrigin(payload.replyOrigin)
            ? { replyOrigin: crossChannelReplyOrigin(payload.replyOrigin) } : {}),
        })
        : Promise.resolve();
      const logged = postCommit.catch((error: unknown) => {
        console.error("Channel family Agent post-commit failed", {
          channelId,
          messageId: input.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      // A launch finishes before the append answers, as on the HTTP route: a
      // backgrounded summon vanishes with its isolate, and a launch its
      // Channel coordinator was not told about fails the append for retry.
      if (productMessageControlFinishesBeforeResponse(body)) {
        await postCommit.catch((error: unknown) => {
          if (error instanceof AgentLaunchHandoverUnavailable) throw error;
        });
      }
      const background = Promise.all([liveDelivery, logged]).then(() => undefined);
      if (scheduleBackground) scheduleBackground(background);
      else await background;
      return payload;
    },
  };
}

/** A message call's answer, or its failure classified the way message routes answer it. */
export async function messageCall(
  family: string,
  work: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return await work();
  } catch (error) {
    const failure = postgresMessageFailure(error);
    throw new RuntimeAuthorityOperationError(family, failure.status, failure.body);
  }
}

/** A Channel's history as one principal reads it. */
export function channelHistoryAs(
  env: Env,
  input: { channelId: string; limit: number; before?: string; beforeSequence?: number; afterSequence?: number;
    principal: { kind: "user" | "agent"; id: string } },
): Promise<Record<string, unknown>> {
  return messageCall("channel-history", () => channelMessageHistory(env, input));
}

function requiredChannelId(family: string, input: Record<string, unknown>): string {
  const channelId = typeof input.channelId === "string" ? input.channelId : "";
  if (!channelId) throw new RuntimeAuthorityOperationError(family, 400, { error: "channelId is required" });
  return channelId;
}

export function runtimeCommandId(prefix: string, identity?: string): string {
  const suffix = identity?.trim() || crypto.randomUUID();
  return `${prefix}:${suffix}`.slice(0, 200);
}

/** Use an entity's optimistic-concurrency version in a stable command identity. */
export function runtimeVersionedCommandId(prefix: string, identity: string, expectedVersion: number): string {
  return runtimeCommandId(prefix, `${identity}:${expectedVersion}`);
}

export function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`PostgreSQL response is missing ${field}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return plainRecord(value) !== undefined;
}
