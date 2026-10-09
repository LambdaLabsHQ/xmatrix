/** PostgreSQL-backed port for agent mention orchestration. */

import type { ChannelAttachment } from "@xmatrix/protocol";
import type { HubAuthorityEnv } from "./postgres-authority-fleet";
import { appendChannelMessage } from "./channel-messages";
import type { Env } from "./types";
import { decideNewConversationLaunch, dispatchRegistrationInput, prepareRegistrationHandoff,
  prepareRegistrationReborn } from "./registration-launch-dispatch";
import { runtimeRepository } from "./runtime";
import { launchHandoffSuccessorElsewhere } from "./handoff-elsewhere";
import { ControlError, RegistrationAccessError } from "@xmatrix/db";
import { getChannel, getSpace } from "./spaces";
import {
  orchestrateProductAgentMentions,
  orchestrateProductChannelAbout,
  orchestrateProductNewConversationStart,
  productSpacePreferredLanguage,
  type ProductAgentMentionPort,
  type ProductAgentMentionOrchestrationResult,
  type ProductChannelView } from "./product-agent-mention";
import { XMATRIX_SYSTEM_AVATAR_URL, XMATRIX_SYSTEM_LABEL } from "./xmatrix-system-identity";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { AgentLaunchHandoverUnavailable, wakeAgentLaunchChannel } from "./agent-launch-coordinator-wake";
import { sha256Hex } from "@xmatrix/protocol";
import { stopChannelAboutSessions } from "./channel-about-session-stop";

export async function dispatchPreparedAgentLaunchWake(input: {
  /** One coordinator per Channel: a Launch never waits behind another Channel's. */
  channels?: DurableObjectNamespace;
  channelId: string;
  launchIds: readonly string[];
  shardId?: string;
}): Promise<"skipped" | "woken"> {
  // A fully rejected batch is a valid prepare result. There is no durable work
  // to wake, and the coordinator intentionally rejects an empty launch set.
  if (input.launchIds.length === 0) return "skipped";
  const wake = await wakeAgentLaunchChannel(input.channels, { ...input, work: ["launch"] })
    .catch(() => { throw new AgentLaunchHandoverUnavailable(); });
  if (!wake.ok) throw new AgentLaunchHandoverUnavailable(wake.status);
  return "woken";
}

export interface ProductAgentMentionAuthorityEnv extends HubAuthorityEnv {
  XMATRIX_MOCK_AUTH_TOKEN?: string;
  XMATRIX_MOCK_SCHEDULE_DELAY_MS?: string;
  RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL?: DurableObjectNamespace;
}

function commandId(family: string, stable: string): string {
  return `product:${family}:${stable}`.slice(0, 200);
}

export async function productAgentSystemNoticeId(
  sourceMessageId: string,
  channelId: string,
  body: string,
): Promise<string> {
  const suffix = await sha256Hex(JSON.stringify([sourceMessageId, channelId, body]));
  return `system:${sourceMessageId}:${suffix}`.slice(0, 200);
}

export function productAgentSystemNoticeSenderSnapshot(
  actorUserId: string,
): Record<string, string> {
  return {
    identityId: `user:${actorUserId}`,
    kind: "user",
    userId: actorUserId,
    email: `${actorUserId.replace(/[^a-zA-Z0-9._-]/gu, "_")}@unknown.invalid`,
    label: XMATRIX_SYSTEM_LABEL,
    name: XMATRIX_SYSTEM_LABEL,
    avatarUrl: XMATRIX_SYSTEM_AVATAR_URL,
  };
}

export async function dispatchProductAgentSystemNotice(input: {
  env: HubAuthorityEnv;
  actorUserId: string;
  sourceMessageId: string;
  channelId: string;
  body: string;
  metadata?: Record<string, unknown>;
  /** The message this notice answers, when a message asked for the work. */
  replyToMessageId?: string;
  append?: typeof appendChannelMessage;
}): Promise<void> {
  const messageId = await productAgentSystemNoticeId(
    input.sourceMessageId,
    input.channelId,
    input.body,
  );
  const noticeCommand = {
    commandId: commandId("system-notice", messageId),
    messageId,
    channelId: input.channelId,
    body: input.body,
    principal: { kind: "user", id: input.actorUserId },
    senderSnapshot: productAgentSystemNoticeSenderSnapshot(input.actorUserId),
    residual: {
      appMetadata: {
        ...input.metadata,
        xmatrixProvenance: "system_fact",
        xmatrixSystemNotice: true,
        sourceMessageId: input.sourceMessageId,
      },
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    },
  };
  try {
    await (input.append ?? appendChannelMessage)(input.env as Env, input.channelId, noticeCommand);
  } catch (error) {
    // Carry the authority's code so a caller can tell a Channel that can never
    // take the notice (archived, gone) from a transient outage.
    if (error instanceof ControlError) {
      throw Object.assign(new Error(`system notice failed (${error.status}): ${error.message}`), { code: error.code });
    }
    throw error;
  }
}

/** A read the launch can do without: its failure is logged and answered as null. */
async function readOrLog<T extends Record<string, unknown>>(
  operation: string,
  read: () => Promise<T>,
  context: Record<string, string>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error("Product agent mention Authority read failed", {
      operation,
      ...(error instanceof ControlError ? { status: error.status } : {}),
      error: error instanceof Error ? error.message : String(error),
      ...context,
    });
    return null;
  }
}

export function createProductAgentMentionAuthorityPort(input: {
  env: ProductAgentMentionAuthorityEnv;
  actorUserId: string;
  /** Stable message id used for system-notice idempotency keys. */
  sourceMessageId: string;
  /**
   * Runtime inbound frames already own the live session. A wake fetch back
   * into that same isolate deadlocks; the frame delivers locally after issue.
   */
  skipDaemonWake?: boolean;
}): ProductAgentMentionPort {
  /** One registration handoff under a command stable per source message, Instance and successor. */
  const handoffPrepare = (handoff: { channelId: string; sourceInstanceId: string; sourceMessageId: string;
    sourceMention: string; successorHarness: string; prompt: string }) => prepareRegistrationHandoff(input.env as Env, {
    commandId: `registration-handoff:${handoff.sourceMessageId}:${handoff.sourceInstanceId}:${handoff.successorHarness}`
      .slice(0, 200),
    actorUserId: input.actorUserId, ...handoff,
  });
  const principal = { kind: "user" as const, id: input.actorUserId };
  /** A prepared reborn or handoff is the Channel coordinator's to carry: tell it before answering. */
  const handedToReborn = async (channelId: string, result: { intentId?: unknown; state?: unknown },
    failure: "registration_reborn_failed" | "registration_handoff_failed") => {
    if (typeof result.intentId !== "string") throw new RegistrationAccessError(failure, 502);
    await wakeAgentLaunchCoordinator(input.env, channelId, ["reborn"]);
    return { intentId: result.intentId, state: String(result.state) };
  };

  return {
    launchRegistrationInput: (launch) => dispatchRegistrationInput({
      env: input.env as Env, actorUserId: input.actorUserId, ...launch }),
    async decideFirstMessageLaunch(decision) {
      return decideNewConversationLaunch(input.env as Env, {
        commandId: `new-conversation:${decision.messageId}`.slice(0, 200), actorUserId: input.actorUserId, ...decision,
      });
    },
    async stopChannelAboutSessions(targets, attempt) {
      await stopChannelAboutSessions(input.env as Parameters<typeof stopChannelAboutSessions>[0], targets,
        "Channel About session finished its turn", attempt);
    },
    async getChannel(channelId) {
      const payload = await readOrLog("get-channel", () => getChannel(input.env, { channelId, principal }),
        { channelId, sourceMessageId: input.sourceMessageId });
      const channel = payload?.channel as Record<string, unknown> | undefined;
      if (!channel || typeof channel.id !== "string" || typeof channel.spaceId !== "string") {
        return null;
      }
      return {
        id: channel.id,
        ...(typeof channel.name === "string" ? { name: channel.name } : {}),
        spaceId: channel.spaceId,
        mode: channel.mode === "closed" ? "closed" : "open",
        ...(typeof channel.archivedAt === "string" ? { archivedAt: channel.archivedAt } : {}),
        ...(channel.metadata && typeof channel.metadata === "object" && !Array.isArray(channel.metadata)
          ? { metadata: channel.metadata as Record<string, unknown> }
          : {}),
      } satisfies ProductChannelView;
    },

    async getSpacePreferredLanguage(spaceId) {
      const space = await readOrLog("get-space", () => getSpace(input.env, { spaceId, principal }),
        { spaceId, sourceMessageId: input.sourceMessageId });
      return productSpacePreferredLanguage(space?.metadata);
    },

    async prepareRegisteredReborn({ channelId, sourceInstanceId, sourceMessageId, sourceMention, prompt }) {
      const result = await prepareRegistrationReborn(input.env as Env, {
        commandId: `registration-reborn:${sourceMessageId}:${sourceInstanceId}`.slice(0, 200),
        actorUserId: input.actorUserId, channelId, sourceInstanceId, sourceMessageId, sourceMention, prompt,
      }) as { intentId?: unknown; state?: unknown };
      return handedToReborn(channelId, result, "registration_reborn_failed");
    },

    async prepareRegisteredHandoff({ channelId, sourceInstanceId, sourceMessageId, sourceMention, successorHarness, prompt }) {
      const result = await handoffPrepare({ channelId, sourceInstanceId, sourceMessageId, sourceMention,
        successorHarness, prompt });
      return handedToReborn(channelId, result, "registration_handoff_failed");
    },

    async prepareRegisteredAutoHandoff({ channelId, sourceInstanceId, sourceMessageId, sourceMention, prompt }) {
      const result = await handoffPrepare({ channelId, sourceInstanceId, sourceMessageId, sourceMention,
        successorHarness: "auto", prompt });
      const outcome = result.outcome;
      if (outcome !== "handed_off" && outcome !== "no_successor" && outcome !== "not_transferable" &&
          outcome !== "source_transferred" && outcome !== "refused") {
        throw new RegistrationAccessError("registration_handoff_failed", 502);
      }
      return { outcome,
        ...(typeof result.successorHarness === "string" ? { successorHarness: result.successorHarness } : {}),
        ...(typeof result.repository === "string" && result.repository.trim()
          ? { repository: result.repository.trim().slice(0, 1_000) } : {}),
        ...(typeof result.code === "string" ? { code: result.code } : {}) };
    },

    async handOffElsewhere(handoff) {
      const { agentName } = await launchHandoffSuccessorElsewhere(input.env as Env, handoff);
      return { agentName };
    },

    async getRebornTarget({ channelId, agentName, channelInstanceId }) {
      let payload: { target?: unknown };
      try {
        payload = await runtimeRepository(input.env).getChannelAgentRebornTarget({ requestId: crypto.randomUUID(),
          channelId, agentName, channelInstanceId, actorUserId: input.actorUserId });
      } catch (error) {
        if (error instanceof ControlError && error.status === 404) return null;
        console.error("Product agent mention reborn target read failed", { channelId,
          sourceMessageId: input.sourceMessageId, error: error instanceof Error ? error.message : String(error) });
        return null;
      }
      const target = payload.target;
      if (!target || typeof target !== "object" || Array.isArray(target)) return null;
      const value = target as Record<string, unknown>;
      const workspace = value.workspace && typeof value.workspace === "object" &&
          !Array.isArray(value.workspace)
        ? value.workspace as Record<string, unknown>
        : undefined;
      if (
        typeof value.instanceId !== "string" ||
        typeof value.instanceStatus !== "string" ||
        typeof value.channelId !== "string" ||
        !Number.isSafeInteger(value.channelInstanceId) ||
        typeof value.runId !== "string" ||
        typeof value.runStatus !== "string" ||
        typeof value.agentName !== "string" ||
        typeof value.harness !== "string" ||
        typeof value.ownerUserId !== "string"
      ) {
        return null;
      }
      return {
        instanceId: value.instanceId,
        instanceStatus: value.instanceStatus,
        channelId: value.channelId,
        channelInstanceId: value.channelInstanceId as number,
        runId: value.runId,
        runStatus: value.runStatus,
        agentName: value.agentName,
        harness: value.harness,
        ownerUserId: value.ownerUserId,
        ...(typeof workspace?.machineId === "string" && typeof workspace.canonicalCwd === "string"
          ? { workspace: { machineId: workspace.machineId, canonicalCwd: workspace.canonicalCwd } }
          : {}),
        metadata: value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
          ? value.metadata as Record<string, unknown>
          : {},
      };
    },

    async getHandoffTarget(input) {
      return this.getRebornTarget(input);
    },

    async publishSystemNotice(channelId, body) {
      await dispatchProductAgentSystemNotice({ env: input.env,
        actorUserId: input.actorUserId, sourceMessageId: input.sourceMessageId,
        channelId, body });
    },

    reportDiagnostic({ stage, error, ...where }) {
      // Stage and code lead the message, so error reporting groups each cause once and names it.
      console.error(`Product agent mention ${stage} failed: ${error}`, JSON.stringify(where));
    },
  };
}

interface AuthorityMessageMentionInput {
  env: ProductAgentMentionAuthorityEnv;
  channelId: string;
  messageId: string;
  body: string;
  actorUserId: string;
  triggerCommittedAt?: string;
  interpretStartedAt?: string;
  attachments?: ChannelAttachment[];
  skipCreateInstanceMentions?: boolean;
}

function authorityMessageMentionInput(input: AuthorityMessageMentionInput) {
  return {
    channelId: input.channelId,
    messageId: input.messageId,
    body: input.body,
    actorUserId: input.actorUserId,
    ...(input.triggerCommittedAt ? { triggerCommittedAt: input.triggerCommittedAt } : {}),
    ...(input.interpretStartedAt ? { interpretStartedAt: input.interpretStartedAt } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.skipCreateInstanceMentions ? { skipCreateInstanceMentions: true } : {}),
    port: createProductAgentMentionAuthorityPort({
      env: input.env,
      actorUserId: input.actorUserId,
      sourceMessageId: input.messageId,
    }),
  };
}

export async function dispatchProductAgentMentionsAfterAuthorityMessage(
  input: AuthorityMessageMentionInput,
): Promise<ProductAgentMentionOrchestrationResult> {
  const result = await orchestrateProductAgentMentions(authorityMessageMentionInput(input));
  console.log("Product agent mention orchestration completed", {
    channelId: input.channelId,
    messageId: input.messageId,
    considered: result.considered,
    spawned: result.spawned,
    noticeCount: result.notices.length,
  });
  return result;
}

/** A new conversation's first message that summons nobody; see
 * `orchestrateProductNewConversationStart`. */
export async function dispatchProductNewConversationStart(input: {
  env: ProductAgentMentionAuthorityEnv; channelId: string; messageId: string; body: string; actorUserId: string;
  authorKind?: "user" | "agent";
}): Promise<{ harness?: string }> {
  return orchestrateProductNewConversationStart({
    channelId: input.channelId, messageId: input.messageId, body: input.body,
    ...(input.authorKind ? { authorKind: input.authorKind } : {}),
    port: createProductAgentMentionAuthorityPort({
      env: input.env, actorUserId: input.actorUserId, sourceMessageId: input.messageId }),
  });
}

export async function dispatchProductChannelAbout(input: {
  env: ProductAgentMentionAuthorityEnv;
  spaceId?: string;
  channelId: string;
  requestId: string;
  triggerMessageId?: string;
  successorOfRunId?: string;
  actorUserId: string;
  skipDaemonWake?: boolean;
  automaticNameOnly?: boolean;
}): Promise<ProductAgentMentionOrchestrationResult> {
  return orchestrateProductChannelAbout({
    ...(input.automaticNameOnly ? { automaticNameOnly: true } : {}),
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    channelId: input.channelId,
    requestId: input.requestId,
    ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
    ...(input.successorOfRunId ? { successorOfRunId: input.successorOfRunId } : {}),
    actorUserId: input.actorUserId,
    port: createProductAgentMentionAuthorityPort({
      env: input.env,
      actorUserId: input.actorUserId,
      sourceMessageId: input.requestId,
      ...(input.skipDaemonWake === true ? { skipDaemonWake: true } : {}),
    }),
  });
}
