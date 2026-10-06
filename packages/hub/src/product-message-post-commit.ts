import { captureServerErrorDiagnostic } from "./server-error-diagnostic";
import type { ChannelAttachment } from "@xmatrix/protocol";
import { parseMessageInteraction, createInstanceMentions, filterOperationalMentions, hasRetiredAgentLaunchMention, parseAutoLaunchMentions,
  parseHarnessCapabilityMentions, PREPARATION_REJECTION_MESSAGES, RETIRED_AGENT_LAUNCH_NOTICE, REGISTRATION_PREPARATION_REJECTION_CODES } from "@xmatrix/protocol";
import {
  dispatchProductAgentMentionsAfterAuthorityMessage,
  dispatchProductChannelAbout,
  dispatchProductManagementAgentMentionAfterAuthorityMessage,
  dispatchProductNewConversationStart,
  dispatchProductAgentSystemNotice,
  type ProductAgentMentionAuthorityEnv,
} from "./product-agent-mention-authority-adapter";
import { dispatchProductMessageAppend } from "./product-message-append";
import {
  dispatchProductAgentInterventionAfterAuthorityMessage,
} from "./product-agent-intervention-authority-adapter";
import {
  dispatchProductAgentControlAfterAuthorityMessage,
} from "./product-agent-model-effort-authority-adapter";
import { connectorForCommand } from "./connectors/registry";
import type { Env } from "./types";
import { relayCrossChannelReply, type CrossChannelReplyOrigin } from "./product-cross-channel-reply";
import { recordAgentLaunchStage } from "./postgres-observability";
import { dispatchRegistrationLaunchesAfterMessage, wakeRestingInstances } from "./registration-launch-dispatch";
import { runtimeRepository } from "./runtime";
import { ControlError } from "@xmatrix/db";
import { AgentLaunchHandoverUnavailable } from "./agent-launch-coordinator-wake";
import { pageReferencesIn } from "@xmatrix/protocol";
import { firstMessageSummonId, PostgresPageRepository, XMATRIX_SYSTEM_AUTHOR_ID } from "@xmatrix/db";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { attachConversationToPage } from "./product-page-attachment";
import { judgeMessageSupersession } from "./message-supersession";
import { CHANNEL_ACTIVITY_MESSAGE_KIND } from "@xmatrix/protocol";

/** Product control must finish before the HTTP response. A dropped or timed-out
 * waitUntil can leave a committed command with no daemon request or receipt. */
export function productMessageControlFinishesBeforeResponse(body: string): boolean {
  const plan = parseMessageInteraction(body);
  return !!plan.stop || plan.controls.length > 0 || plan.launches.length > 0 ||
    plan.reborn.length > 0 || plan.handoff.length > 0;
}

export type ProductMessagePostCommitEnv = ProductAgentMentionAuthorityEnv & Env;

export interface ProductMessagePostCommitInput {
  env: ProductMessagePostCommitEnv;
  channelId: string;
  messageId: string;
  body: string;
  /** Absent for ordinary text; activity entries are never interpreted. */
  messageKind?: string;
  actorUserId: string;
  /** `system`: xMatrix's own summon (`summonFirstMessageHarness`). */
  senderKind: "user" | "agent" | "system";
  senderId: string;
  senderRunId?: string;
  committedAt?: string;
  attachments?: ChannelAttachment[];
  sequence?: number;
  /** Keeps the quota probe running after this decision returns. */
  scheduleBackground?: (task: Promise<unknown>) => void;
  /** Set by the append when this message replies to a cross-Channel link. */
  replyOrigin?: CrossChannelReplyOrigin;
}

/**
 * When a conversation's About (summary, and its name while automatic) is
 * written: after every fifth message, and after the first one while nobody
 * has named the conversation, so a new conversation is named at once.
 */
export function channelAboutRequestId(channelId: string, sequence: number | undefined): string | undefined {
  if (sequence === 1) return `channel-about:${channelId}:0`;
  if (!Number.isInteger(sequence) || sequence! < 5 || sequence! % 5 !== 0) return undefined;
  return `channel-about:${channelId}:${Math.floor(sequence! / 5)}`;
}

export function productMessagePostCommitAuthorPolicy(senderKind: ProductMessagePostCommitInput["senderKind"]): {
  interpretAgentIntervention: true;
  interpretAgentLifecycle: true;
  interpretHumanConversationWake: boolean;
} {
  return {
    interpretAgentIntervention: true,
    interpretAgentLifecycle: true,
    interpretHumanConversationWake: senderKind === "user",
  };
}

export function productMessagePostCommitShouldWakeConversation(
  senderKind: ProductMessagePostCommitInput["senderKind"],
  body: string,
): boolean {
  const plan = parseMessageInteraction(body);
  return senderKind === "user" && !plan.refused && !plan.stop && plan.controls.length === 0 &&
    plan.launches.length === 0 && plan.reborn.length === 0 && plan.handoff.length === 0;
}

/**
 * Whether this message wakes the Channel's resting Instances. Any message a
 * live Instance would receive does (docs/instance-sleep.md §3), except the
 * lifecycle controls that own their targets: a stop, `/kill all`, a reborn or
 * a handoff. An Auto/harness summon also owns its selected Run: waking sleeping peers
 * with that same first prompt would bypass the live context-only delivery.
 */
export function productMessageWakesRestingInstances(body: string): boolean {
  const plan = parseMessageInteraction(body);
  return !plan.refused && !plan.stop && plan.controls.length === 0 && plan.launches.length === 0 &&
    plan.reborn.length === 0 && plan.handoff.length === 0;
}

/** Prepare the wake of every resting Instance in the message's Channel. */
export async function dispatchRestingInstanceWake(input: ProductMessagePostCommitInput,
  wake = wakeRestingInstances): Promise<void> {
  await wake(input.env, { commandId: `resting-wake:${input.messageId}`.slice(0, 200), channelId: input.channelId,
    sourceMessageId: input.messageId, prompt: input.body });
}

function postCommitTaskInput(input: ProductMessagePostCommitInput) {
  return {
    env: input.env,
    channelId: input.channelId,
    messageId: input.messageId,
    body: input.body,
    actorUserId: input.actorUserId,
    ...(input.committedAt ? { triggerCommittedAt: input.committedAt } : {}),
    interpretStartedAt: new Date().toISOString(),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  };
}

function logPostCommitFailure(label: string, input: ProductMessagePostCommitInput, error: unknown) {
  console.error(label, {
    channelId: input.channelId,
    messageId: input.messageId,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** A thrown error's stable classification, never its message text. */
function publicErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[a-z][a-z0-9_.-]{0,79}$/u.test(code) ? code : undefined;
}

export function unconfirmedLaunchNoticeBody(error: unknown, diagnosticId: string): string {
  const code = publicErrorCode(error);
  // The authority refused the whole dispatch below 500 only before any summon
  // was prepared (each summon's own refusal is a recorded rejection), so the
  // registration cause is certain. A 5xx with the same code is not.
  const refusal = error instanceof ControlError && error.status < 500 && code &&
    REGISTRATION_PREPARATION_REJECTION_CODES.includes(code) ? PREPARATION_REJECTION_MESSAGES[code] : undefined;
  if (refusal) return `${refusal} (${code}) Diagnostic reference: ${diagnosticId}`;
  return "The launch request could not be confirmed" + (code ? ` (${code})` : "") +
    ". An Agent may already have been allocated. Check this message's launch status before " +
    `submitting the message again. Diagnostic reference: ${diagnosticId}`;
}

/** Authenticated Agent publications use the same Channel launch authority as
 * lifecycle mentions. actorUserId is resolved from the publishing Run's owner
 * upstream; it is never supplied by the message body. PostgreSQL checks both
 * current Channel permission and the unchanged owner-bound source publication. */
/** A new conversation's first message that summons nobody, from a Human or an Agent. */
async function startNewConversation(input: ProductMessagePostCommitInput): Promise<void> {
  const { harness } = await dispatchProductNewConversationStart({ env: input.env, channelId: input.channelId,
    messageId: input.messageId, body: input.body, actorUserId: input.actorUserId,
    authorKind: input.senderKind === "agent" ? "agent" : "user" });
  if (harness) await summonFirstMessageHarness({ env: input.env, channelId: input.channelId,
    messageId: input.messageId, actorUserId: input.actorUserId, harness });
}

/**
 * The harness decided for a new conversation's first message, by its author
 * or by Jev, is summoned like any other: xMatrix replies `@<harness>` in the
 * Channel, and that message goes through this same post-commit pipeline. It
 * launches as the first message's author, whose decision the launch
 * authority checks. Its id derives from the first message, so a retry
 * appends and launches nothing new.
 */
export async function summonFirstMessageHarness(input: { env: ProductMessagePostCommitEnv; channelId: string;
  messageId: string; actorUserId: string; harness: string },
  dependencies = { append: dispatchProductMessageAppend, postCommit: dispatchProductMessagePostCommit }): Promise<void> {
  // The decision already answered whether to start, so Jev's intent check is skipped.
  const body = `@${input.harness} launch:force`;
  const messageId = firstMessageSummonId(input.messageId);
  const response = await dependencies.append(input.env, input.channelId, {
    commandId: `first-message-summon:${input.messageId}`.slice(0, 200), messageId, channelId: input.channelId, body,
    principal: { kind: "user", id: input.actorUserId }, xmatrixAuthor: true,
    residual: { replyToMessageId: input.messageId },
  });
  if (!response.ok) throw new Error(`First message summon append failed (${response.status})`);
  await dependencies.postCommit({ env: input.env, channelId: input.channelId, messageId, body,
    actorUserId: input.actorUserId, senderKind: "system", senderId: XMATRIX_SYSTEM_AUTHOR_ID,
    committedAt: new Date().toISOString() });
}

export async function dispatchProductMessageLaunches(input: ProductMessagePostCommitInput,
  dispatch: { registration: typeof dispatchRegistrationLaunchesAfterMessage;
    newConversation?: (input: ProductMessagePostCommitInput) => Promise<unknown> } =
    { registration: dispatchRegistrationLaunchesAfterMessage },
  notice = dispatchProductAgentSystemNotice): Promise<boolean> {
  const interaction = parseMessageInteraction(input.body);
  if (interaction.stop || interaction.controls.length || interaction.refused === "message_too_long") return false;
  const lifecycleRanges = [...interaction.reborn, ...interaction.handoff];
  const remainingInstanceMentions = filterOperationalMentions(input.body, createInstanceMentions(input.body))
    .filter(mention => !lifecycleRanges.some(range => mention.start >= range.start && mention.start < range.end));
  if (lifecycleRanges.length && !interaction.launches.length && !remainingInstanceMentions.length) return false;
  // Retired public syntax is refused before any address resolves, so
  // `@name:new` never launches the registration that shares the name.
  if (hasRetiredAgentLaunchMention(input.body)) {
    await notice({ ...input, sourceMessageId: input.messageId, body: RETIRED_AGENT_LAUNCH_NOTICE });
    return true;
  }
  // `@auto`, a harness shout or an Instance address from any author (Human,
  // Agent, Automation), or a Human's picker selections: every launch is the
  // registration dispatch, which records a refusal where the message shows it.
  const directMention = filterOperationalMentions(input.body, parseHarnessCapabilityMentions(input.body)).length > 0 ||
    parseAutoLaunchMentions(input.body).some(mention => mention.text.slice(1, 5).toLowerCase() === "auto") ||
    filterOperationalMentions(input.body, createInstanceMentions(input.body)).length > 0;
  // A conversation's first message is read the same whoever wrote it.
  if (!directMention && input.senderKind !== "user" && input.sequence !== 1) return false;
  try {
    const { selectionCount, rejected } = await dispatch.registration(input);
    // A successful dispatch can contain terminal preparation refusals without
    // allocating any Run. Persisted diagnose evidence alone is not a receipt.
    // The system notice is source-bound and idempotent across message retries.
    for (const code of new Set((rejected ?? []).map(item => item.code))) {
      const reason = REGISTRATION_PREPARATION_REJECTION_CODES.includes(code)
        ? PREPARATION_REJECTION_MESSAGES[code] : PREPARATION_REJECTION_MESSAGES.registration_launch_rejected;
      await notice({ ...input, sourceMessageId: input.messageId, replyToMessageId: input.messageId,
        body: `Agent launch failed: ${reason} (${REGISTRATION_PREPARATION_REJECTION_CODES.includes(code) ? code : "registration_launch_rejected"})`,
      }).catch(error => {
        logPostCommitFailure("Launch rejection notice failed", input, error);
        throw new AgentLaunchHandoverUnavailable();
      });
    }
    if (selectionCount > 0 || directMention) return selectionCount > 0;
    // Nobody was summoned by the first message of a conversation: Jev reads
    // whether its author wants an Agent to start (only a new, unnamed one).
    if (input.sequence === 1) await (dispatch.newConversation ?? startNewConversation)(input);
    return false;
  } catch (error) {
    // Committed launch work its Channel was not told about: fail the message
    // request instead, so its idempotent retry prepares nothing new and tells it.
    if (error instanceof AgentLaunchHandoverUnavailable) throw error;
    if (!directMention) {
      logPostCommitFailure("Registration launch dispatch failed", input, error);
      return false;
    }
    // An exception can occur after allocation commits or a wake is delivered.
    // Do not claim no Agent started, or copy the exception into the channel:
    // the full cause goes to the Worker log under a diagnostic reference, and
    // the Channel gets that reference plus the error's stable code, if it has one.
    const diagnostic = captureServerErrorDiagnostic("launch.dispatch.registration", error,
      { channelId: input.channelId, messageId: input.messageId });
    await notice({ ...input, sourceMessageId: input.messageId,
      body: unconfirmedLaunchNoticeBody(error, diagnostic.diagnosticId),
    }).catch(failure => logPostCommitFailure("Launch failure notice failed", input, failure));
    return true;
  }
}

/**
 * Run bounded, idempotent product interpretation after one canonical message
 * commit. HTTP Human/Agent message routes, Relay authority scheduled delivery, and
 * Agent Runtime WebSocket appends (via Authority appendMessage waitUntil) must use
 * this same entry point so syntax never acquires source-specific behavior.
 */
export async function dispatchProductMessagePostCommit(
  input: ProductMessagePostCommitInput,
): Promise<void> {
  // An activity entry is a fact the runtime recorded, not something anyone
  // said: nothing in its body is a mention, command, page link or launch.
  if (input.messageKind === CHANNEL_ACTIVITY_MESSAGE_KIND) return;
  const tasks: Promise<unknown>[] = [];
  // Interpretation nobody waits on (supersession, page links, the About) never
  // holds a launch's HTTP response: given a background scheduler, it runs there.
  const sideTasks: Promise<unknown>[] = [];
  if (input.senderKind !== "system" && input.sequence !== undefined && Number.isSafeInteger(input.sequence) &&
      input.sequence > 0) {
    sideTasks.push(judgeMessageSupersession({
      env: input.env, channelId: input.channelId, messageId: input.messageId,
      sequence: input.sequence, principal: { kind: input.senderKind, id: input.senderId },
    }).catch((error) => {
      logPostCommitFailure("Message supersession judgment failed", input, error);
    }));
  }
  const authorPolicy = productMessagePostCommitAuthorPolicy(input.senderKind);
  const interaction = parseMessageInteraction(input.body);
  const lifecycleMention = interaction.reborn.length > 0 || interaction.handoff.length > 0;
  if (lifecycleMention) {
    const committedMs = Date.parse(input.committedAt || "");
    recordAgentLaunchStage({ env: input.env, stage: "message_commit_to_interpret", outcome: "ok",
      durationMs: Number.isFinite(committedMs) ? Math.max(0, Date.now() - committedMs) : 0 });
  }
  if (input.senderKind === "agent" && input.senderRunId) {
    const started = performance.now();
    sideTasks.push(runtimeRepository(input.env).recordAgentLaunchFirstReply({ requestId: crypto.randomUUID(),
      channelId: input.channelId, runId: input.senderRunId, actorUserId: input.actorUserId,
      at: new Date().toISOString() }).then((result) => {
      if (result.recorded === true) recordAgentLaunchStage({ env: input.env, stage: "first_reply_append",
        outcome: "ok", durationMs: Number(result.launchAgeMs ?? performance.now() - started) });
    }).catch((error) => {
      recordAgentLaunchStage({ env: input.env, stage: "first_reply_append", outcome: "error",
        durationMs: performance.now() - started });
      logPostCommitFailure("Agent Launch first reply observation failed", input, error);
    }));
  }
  const pageReferences = pageReferencesIn(input.body);
  if (pageReferences.length > 0) {
    // A message that refers to a page links it to this conversation, as its author.
    sideTasks.push(new PostgresPageRepository(createPostgresAuthorityDatabase(input.env, {
      applicationName: "xmatrix-page-references", statementTimeoutMs: 5_000,
      transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
    })).linkReferences({ requestId: crypto.randomUUID(), conversationId: input.channelId,
      principal: { kind: "user", id: input.actorUserId }, pageIds: pageReferences,
    }).catch((error) => {
      logPostCommitFailure("Page reference linking failed", input, error);
    }));
  }
  // Jev attaches a new conversation to the page it is about, from its first human messages.
  if (input.senderKind === "user" && input.sequence !== undefined && input.sequence <= 3 &&
      pageReferences.length === 0) {
    sideTasks.push(attachConversationToPage({ env: input.env, conversationId: input.channelId,
      body: input.body, actorUserId: input.actorUserId,
    }).catch((error) => {
      logPostCommitFailure("Page attachment failed", input, error);
    }));
  }
  if (input.replyOrigin) {
    tasks.push(relayCrossChannelReply({
      env: input.env,
      origin: input.replyOrigin,
      channelId: input.channelId,
      messageId: input.messageId,
      body: input.body,
    }).catch((error) => {
      logPostCommitFailure("Cross-Channel reply relay failed", input, error);
    }));
  }
  const connector = input.senderKind === "system" ? undefined : connectorForCommand(input.body);
  if (connector?.commands) {
    tasks.push(
      connector.commands.run({ ...input, senderKind: input.senderKind === "agent" ? "agent" : "user" }).catch((error) => {
        logPostCommitFailure(`Product ${connector.id} connector orchestration failed`, input, error);
      }),
    );
  }
  const aboutRequestId = channelAboutRequestId(input.channelId, input.sequence);
  if (aboutRequestId) {
    sideTasks.push(
      dispatchProductChannelAbout({
        env: input.env,
        channelId: input.channelId,
        requestId: aboutRequestId,
        actorUserId: input.actorUserId,
        ...(input.sequence === 1 ? { automaticNameOnly: true } : {}),
      }).catch((error) => {
        console.error("Product Channel About orchestration failed", {
          channelId: input.channelId,
          messageId: input.messageId,
          requestId: aboutRequestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }
  if (authorPolicy.interpretAgentIntervention && interaction.stop) {
    tasks.push(dispatchProductAgentInterventionAfterAuthorityMessage(input).catch((error) => {
      logPostCommitFailure("Product agent intervention orchestration failed", input, error);
    }));
  }
  if (authorPolicy.interpretAgentIntervention && interaction.controls.length) {
    tasks.push(dispatchProductAgentControlAfterAuthorityMessage(input).catch((error) => {
      logPostCommitFailure("Product agent model/effort switch failed", input, error);
    }));
  }
  if (authorPolicy.interpretHumanConversationWake &&
      productMessagePostCommitShouldWakeConversation(input.senderKind, input.body)) {
    tasks.push(
      dispatchProductManagementAgentMentionAfterAuthorityMessage(input).catch((error) => {
        logPostCommitFailure("Product management agent mention orchestration failed", input, error);
      }),
    );
  }
  if (productMessageWakesRestingInstances(input.body)) {
    tasks.push(dispatchRestingInstanceWake(input).catch((error) => {
      logPostCommitFailure("Resting Instance wake failed", input, error);
    }));
  }
  const skipCreateInstanceMentions = await dispatchProductMessageLaunches(input);
  if (authorPolicy.interpretAgentLifecycle && lifecycleMention) {
    tasks.push(
      dispatchProductAgentMentionsAfterAuthorityMessage({
        ...postCommitTaskInput(input),
        skipCreateInstanceMentions,
      }).catch((error) => {
        logPostCommitFailure("Product agent mention orchestration failed", input, error);
      }),
    );
  }
  if (input.scheduleBackground) {
    try { input.scheduleBackground(Promise.all(sideTasks)); }
    catch { tasks.push(...sideTasks); }
  } else tasks.push(...sideTasks);
  await Promise.all(tasks);
}
