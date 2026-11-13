import { ControlError, PostgresNornProgramRepository, XMATRIX_SYSTEM_AUTHOR_ID } from "@xmatrix/db";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { canonicalMentionToken } from "@xmatrix/protocol";
import { markCardAnswered } from "./channel-messages";
import { recordCommandResult } from "./command-result";
import { checkNornProgram, nornDeliveryBody, nornEndBody, nornOutcomeText, nornPersonBody, nornProgramIn, nornRequestCard,
  nornStartLedger, nornStep, personHolder, type NornPassResult, type NornRequestCard } from "./norn-host";
import { createProductAgentInterventionAuthorityPort } from "./product-agent-intervention-authority-adapter";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { postgresMessageRoute } from "./postgres-message-authority";
import { dispatchProductMessageAppend } from "./product-message-append";
import { wakeRestingInstances } from "./registration-launch-dispatch";
import type { ProductMessagePostCommitInput } from "./product-message-post-commit";
import type { Env } from "./types";
import type { Ledger, LedgerRequest, Reply } from "./vendor/norn/runtime/ledger";

/** The message that carries a request of a person as a card. */
const NORN_REQUEST_MESSAGE_KIND = "xmatrix.system.norn-request";

/** After a message xMatrix wrote for a program is committed: its summon starts, its mention wakes. */
type PostCommit = (input: ProductMessagePostCommitInput) => Promise<unknown>;

async function repository(env: Env, channelId: string, requestId: string): Promise<PostgresNornProgramRepository> {
  const database = createPostgresAuthorityDatabase(env, { applicationName: "xmatrix-norn-programs",
    statementTimeoutMs: 5_000, transactionTimeoutMs: 15_000, lockTimeoutMs: 2_000 });
  return new PostgresNornProgramRepository(database, await postgresMessageRoute(env, channelId, requestId, { database }));
}

/**
 * xMatrix says something for a program, under the program's authority: a
 * delivery, or how the program ended. The message id is the fact's own, so a
 * repeat appends nothing and only interprets the message again.
 */
async function say(env: Env, postCommit: PostCommit, input: { channelId: string; messageId: string; body: string;
  authorityUserId: string;
  /** The program's message, when a person or an Agent wrote it: what xMatrix says is a reply to it. */
  replyTo?: string;
  /** The one Instance the message is for. It alone is woken if it rests; nobody else in the conversation is. */
  onlyInstanceId?: string;
  /** Said for whoever reads the conversation: it summons and wakes nobody. */
  quiet?: boolean;
  /** A request of a person: the card the message carries, and the one it waits on. */
  card?: NornRequestCard }): Promise<void> {
  const response = await dispatchProductMessageAppend(env, input.channelId, {
    commandId: `norn-message:${input.messageId}`.slice(0, 200), messageId: input.messageId, channelId: input.channelId,
    body: input.body, principal: { kind: "user", id: input.authorityUserId }, xmatrixAuthor: true,
    ...(input.onlyInstanceId || input.quiet ? {} : { launch: true }),
    ...(input.card ? { messageKind: NORN_REQUEST_MESSAGE_KIND, waitsOnUserIds: [input.card.holderUserId] } : {}),
    ...(input.replyTo || input.card ? { residual: { ...(input.replyTo ? { replyToMessageId: input.replyTo } : {}),
      ...(input.card ? { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true, nornRequest: input.card } } : {}) } } : {}),
  });
  if (!response.ok) throw new Error(`Norn message append failed (${response.status})`);
  if (input.quiet) return;
  if (input.onlyInstanceId) {
    // Live, it has the message already. Interpreting the message as any other would wake every resting Instance here.
    await wakeRestingInstances(env, { commandId: `norn-wake:${input.messageId}`.slice(0, 200), channelId: input.channelId,
      sourceMessageId: input.messageId, targetInstanceId: input.onlyInstanceId, prompt: input.body });
    return;
  }
  await postCommit({ env, channelId: input.channelId, messageId: input.messageId, body: input.body,
    actorUserId: input.authorityUserId, senderKind: "system", senderId: XMATRIX_SYSTEM_AUTHOR_ID,
    committedAt: new Date().toISOString() });
}

/**
 * A committed message that carries a `norn run` block starts that program,
 * with its author's authority. The message is the program's identity: seen
 * again, it starts nothing. Returns what to tell the author when the program
 * could not start.
 */
export async function startNornProgram(input: ProductMessagePostCommitInput): Promise<{ refusal?: string } | undefined> {
  if (input.senderKind === "system") return undefined;
  const program = nornProgramIn(input.body);
  if (!program) return undefined;
  if ("refusal" in program) return program;
  const checked = checkNornProgram(program.source);
  if ("refusal" in checked) return { refusal: `The program was not started:\n\n\`\`\`text\n${checked.refusal}\n\`\`\`` };
  const env = input.env as Env;
  const requestId = `norn-start:${input.messageId}`;
  const started = await (await repository(env, input.channelId, requestId)).start({ requestId, channelId: input.channelId,
    programId: input.messageId, authorKind: input.senderKind, authorityUserId: input.actorUserId,
    authorId: input.senderKind === "agent" ? input.senderInstanceId ?? input.senderId : input.senderId,
    source: program.source, ledger: nornStartLedger }, nornStep());
  // Its first requests wait in the ledger; the Channel's coordinator delivers them. A wake that fails loses
  // nothing: they stay due, and the coordinator's next pass for this conversation delivers them.
  if (started) await wakeAgentLaunchCoordinator(env, input.channelId, ["norn"]).catch((error: unknown) => {
    console.warn("Norn program start could not wake its Channel", { channelId: input.channelId, messageId: input.messageId,
      error: error instanceof Error ? error.message : String(error) });
  });
  return {};
}

/**
 * The Channel's programs, brought up to date: a pass for each one that was
 * stopped, has a deadline due or a request nobody works on any more; then
 * each undelivered request, and each ended program not yet told. Every step
 * is recorded when done, so a pass cut short repeats only what is left.
 */
export async function reconcileNornPrograms(env: Env, channelId: string, postCommit: PostCommit): Promise<void> {
  const requestId = `norn-reconcile:${channelId}`;
  const programs = await repository(env, channelId, requestId);
  for (const programId of (await programs.channelWork({ requestId, channelId })).passes) {
    await programs.advance({ requestId, channelId, programId }, nornStep());
  }
  const work = await programs.channelWork({ requestId, channelId });
  let undeliverable = false;
  for (const delivery of work.deliveries) {
    if (personHolder(delivery.holder)) {
      // A person is found by name among those who can read the conversation, as a mention finds them.
      const named = canonicalMentionToken(delivery.holder.slice(1));
      const people = await programs.people({ requestId, channelId, matches: name => canonicalMentionToken(name) === named });
      const scope = { requestId, channelId, programId: delivery.programId };
      if (people.length !== 1) {
        await programs.advance(scope, nornStep({ requestId: delivery.requestId, epoch: delivery.epoch, reply: { tag: "Broke",
          reason: people.length ? `More than one person here is named ${delivery.holder}` : `Nobody named ${delivery.holder} can read this conversation` } }));
        undeliverable = true;
        continue;
      }
      await say(env, postCommit, { channelId, messageId: delivery.deliveryMessageId, ...(delivery.onPage ? {} : { replyTo: delivery.programId }),
        authorityUserId: delivery.authorityUserId, quiet: true, body: nornPersonBody(delivery.request as LedgerRequest, delivery.requestRef),
        card: nornRequestCard(delivery.request as LedgerRequest, delivery.requestRef, people[0]!) });
      await programs.delivered({ ...scope, ledgerRequestId: delivery.requestId, epoch: delivery.epoch, holderUserId: people[0]! });
      continue;
    }
    // A page's program has its conversation to itself, and its own message there is xMatrix's, which takes no reply.
    await say(env, postCommit, { channelId, messageId: delivery.deliveryMessageId, ...(delivery.onPage ? {} : { replyTo: delivery.programId }),
      authorityUserId: delivery.authorityUserId, ...(delivery.there ? { onlyInstanceId: delivery.there.instanceId } : {}),
      body: nornDeliveryBody(delivery.request as LedgerRequest, delivery.requestRef,
        { ...(delivery.there ? { there: delivery.there.mention } : {}), kept: delivery.onPage }) });
    await programs.delivered({ requestId, channelId, programId: delivery.programId, ledgerRequestId: delivery.requestId, epoch: delivery.epoch,
      ...(delivery.there ? { instanceId: delivery.there.instanceId } : {}) });
  }
  // A request nobody could be found for ended in this pass: what its program does next is due now.
  if (undeliverable) await wakeAgentLaunchCoordinator(env, channelId, ["norn"]);
  // A person's request that ended says how under its card, and no longer waits on them.
  for (const closing of work.closings) {
    if (closing.reply) await recordCommandResult(env, { channelId, messageId: closing.deliveryMessageId, key: "norn-request",
      entry: { note: { text: nornOutcomeText(closing.holder, closing.reply as Reply) } } });
    await markCardAnswered(env, channelId, closing.deliveryMessageId, closing.holderUserId);
    await programs.released({ requestId, channelId, programId: closing.programId, ledgerRequestId: closing.requestId });
  }
  // What a program says goes to its conversation as xMatrix, naming whom it is for; it starts and wakes nobody.
  for (const notice of work.notices) {
    await say(env, postCommit, { channelId, messageId: `norn-say:${notice.noticeId}`, authorityUserId: notice.authorityUserId,
      body: `${notice.recipient} ${notice.body}`.trim(), quiet: true, ...(notice.onPage ? {} : { replyTo: notice.programId }) });
    await programs.noticed({ requestId, channelId, programId: notice.programId, noticeId: notice.noticeId });
  }
  for (const report of work.reports) {
    // An Agent that started the program is told by its address, so it wakes to read the result.
    await say(env, postCommit, { channelId, messageId: `norn-end:${report.programId}`.slice(0, 300),
      // A page's program ends in its own conversation, where only its Instances rest, about to be let go.
      ...(report.onPage ? { quiet: true } : { replyTo: report.programId }),
      authorityUserId: report.authorityUserId,
      body: `${report.authorMention ? `${report.authorMention} ` : ""}${nornEndBody(report.ended as Ledger["ended"])}` });
    await programs.reported({ requestId, channelId, programId: report.programId });
  }
  // An Instance started for a request has nothing left to do in the conversation once the request has ended.
  for (const release of work.releases) {
    const port = createProductAgentInterventionAuthorityPort({ env, actorUserId: release.authorityUserId,
      sourceMessageId: `norn-release:${release.programId}:${release.requestId}`.slice(0, 200) });
    const target = release.runId ? (await port.listKillTargets(channelId)).find(candidate => candidate.runId === release.runId) : undefined;
    if (target) await port.issueStop(target, `norn-release:${release.runId}`.slice(0, 200), "Its request has ended", channelId);
    // At rest it has no Run to stop, and the next message in the conversation would wake it.
    else if (release.mention) await port.stopResting?.(channelId, { mention: release.mention, exclude: [] });
    await programs.released({ requestId, channelId, programId: release.programId, ledgerRequestId: release.requestId });
  }
}

/** The Run that holds a request answers it; the program reads the answer in the same step. */
export async function answerNornRequest(env: Env, input: { channelId: string; runId: string; instanceId: string; requestRef: string;
  outcome: "answered" | "refused" | "broke"; text: string }): Promise<NornPassResult> {
  const requestId = `norn-answer:${input.requestRef}:${crypto.randomUUID()}`;
  const programs = await repository(env, input.channelId, requestId);
  const held = await programs.heldRequest({ requestId, channelId: input.channelId, requestRef: input.requestRef, runId: input.runId, instanceId: input.instanceId })
    .catch(async (error: unknown) => {
      // The answer may have been recorded by a call whose wake failed: its repeat wakes the Channel again.
      if (error instanceof ControlError && error.code === "norn_request_ended") await wakeAgentLaunchCoordinator(env, input.channelId, ["norn"]);
      throw error;
    });
  const reply: Reply | { typed: string } = input.outcome === "answered" ? { typed: input.text }
    : { tag: input.outcome === "refused" ? "Refused" : "Broke", reason: input.text };
  const result = await programs.advance({ requestId, channelId: input.channelId, programId: held.programId },
    nornStep({ requestId: held.requestId, epoch: held.epoch, reply }));
  if (!result) return { status: "failed", refusal: "The request has already ended" };
  // What the answer opened, or the program's end, is the coordinator's to deliver.
  if (!result.refusal) await wakeAgentLaunchCoordinator(env, input.channelId, ["norn"]);
  return result;
}

/**
 * The person a request was delivered to answers it or declines. Only that
 * person holds it: the request is found by their id, never by a name. Returns
 * undefined when they hold no such open request.
 */
export async function answerNornRequestAsPerson(env: Env, input: { channelId: string; userId: string; requestRef: string;
  outcome: "answered" | "refused"; text: string }): Promise<NornPassResult | undefined> {
  const requestId = `norn-answer:${input.requestRef}:${crypto.randomUUID()}`;
  const programs = await repository(env, input.channelId, requestId);
  const held = await programs.personRequest({ requestId, requestRef: input.requestRef, userId: input.userId });
  if (!held || held.channelId !== input.channelId) return undefined;
  const result = await programs.advance({ requestId, channelId: input.channelId, programId: held.programId },
    nornStep({ requestId: held.ledgerRequestId, epoch: held.epoch,
      reply: input.outcome === "answered" ? { typed: input.text } : { tag: "Refused", reason: input.text } }));
  if (!result) return undefined;
  // The card is closed and what the answer opened is delivered by the coordinator.
  if (!result.refusal) await wakeAgentLaunchCoordinator(env, input.channelId, ["norn"]);
  return result;
}

/** The open requests a Run holds and those its Instance's programs wait on. */
export async function openNornRequests(env: Env, input: { channelId: string; runId: string; instanceId: string }) {
  const requestId = `norn-requests:${input.runId}`;
  return (await repository(env, input.channelId, requestId)).openRequests({ requestId, ...input });
}
