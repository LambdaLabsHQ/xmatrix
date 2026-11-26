import { ControlError, PostgresNornProgramRepository, XMATRIX_SYSTEM_AUTHOR_ID } from "@xmatrix/db";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { canonicalMentionToken, NORN_ASK_MESSAGE_PREFIX, NORN_DELEGATED_NOTE } from "@xmatrix/protocol";
import { markCardAnswered } from "./channel-messages";
import { recordCommandResult } from "./command-result";
import { installProgramActionOutcome, type ProgramActionOutcome } from "./connectors/connector-commands";
import { deliverNornAppRequest, withdrawNornAppRequests } from "./norn-actions";
import { agentHolder, appRequest, checkNornProgram, instanceHolder, nornActionAnswer, nornAnswerBody, nornAsking, nornDelivery, nornEndBody, nornOutcomeText, nornPageEnd, nornPersonBody,
  nornPreparedReply, nornProgramIn, nornQuestionSource, nornRequestCard, nornStartLedger, nornStep, personHolder, referencedLibraryNames, selectReferencedLibraries, type NornPassResult, type NornQuestion,
  type NornRequestCard } from "./norn-host";
import { loadSpaceLibraryCatalog } from "./norn-page-programs";
import { nornEventDeliveryAllowed, parseNornEventDeliveryPayload } from "./norn-events";
import { createProductAgentInterventionAuthorityPort } from "./product-agent-intervention-authority-adapter";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { postgresMessageRoute } from "./postgres-message-authority";
import { dispatchProductMessageAppend } from "./product-message-append";
import { wakeRestingInstances } from "./registration-launch-dispatch";
import { runtimeRepository } from "./runtime";
import type { ProductMessagePostCommitInput } from "./product-message-post-commit";
import type { Env } from "./types";
import type { Delegation, Ledger, LedgerRequest, Reply } from "./vendor/norn/runtime/ledger";

/** A program xMatrix wrote for an Agent Run's question: its message is xMatrix's own, which takes no reply. */
const NORN_ASK_PREFIX = NORN_ASK_MESSAGE_PREFIX;
/** What xMatrix says for a program is a reply to the program's message, where a person or an Agent wrote that message. */
const replyTo = (program: { programId: string; onPage: boolean }): { replyTo?: string } =>
  program.onPage || program.programId.startsWith(NORN_ASK_PREFIX) ? {} : { replyTo: program.programId };
/** The message that carries a request of a person as a card. */
const NORN_REQUEST_MESSAGE_KIND = "xmatrix.system.norn-request";

/** A person is found by name among those who can read the conversation, as a mention finds them. */
function peopleNamed(programs: PostgresNornProgramRepository, scope: { requestId: string; channelId: string }, holder: string): Promise<string[]> {
  const named = canonicalMentionToken(holder.slice(1));
  return programs.people({ ...scope, matches: name => canonicalMentionToken(name) === named });
}

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
  card?: NornRequestCard;
  /** The people what is said waits on: it shows where what needs them shows, until they respond. */
  waitsOn?: string[];
  /** A request of an Agent: where in the body the holder's own part begins. A person reads only what comes before it. */
  answerFrom?: number }): Promise<void> {
  const response = await dispatchProductMessageAppend(env, input.channelId, {
    commandId: `norn-message:${input.messageId}`.slice(0, 200), messageId: input.messageId, channelId: input.channelId,
    body: input.body, principal: { kind: "user", id: input.authorityUserId }, xmatrixAuthor: true,
    ...(input.onlyInstanceId || input.quiet ? {} : { launch: true }),
    ...(input.card ? { messageKind: NORN_REQUEST_MESSAGE_KIND, waitsOnUserIds: [input.card.holderUserId] }
      : input.waitsOn?.length ? { waitsOnUserIds: input.waitsOn } : {}),
    ...(input.replyTo || input.card || input.answerFrom ? { residual: { ...(input.replyTo ? { replyToMessageId: input.replyTo } : {}),
      ...(input.card ? { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true, nornRequest: input.card } }
        // Not a system fact: that would make the request context to the Instance it is work for.
        : input.answerFrom ? { appMetadata: { nornAnswerFrom: input.answerFrom } } : {}) } } : {}),
  });
  // Someone to be waited on can no longer read the conversation: what is said is said all the same, to whoever can.
  if (!response.ok && input.waitsOn?.length && !input.card) return say(env, postCommit, { ...input, waitsOn: [] });
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
  const env = input.env as Env;
  const requestId = `norn-start:${input.messageId}`;
  const repo = await repository(env, input.channelId, requestId);
  let spaceLibs: Record<string, string> | undefined;
  let libraryProblems: Record<string, string> | undefined;
  if (referencedLibraryNames(program.source).size > 0) {
    const catalog = await loadSpaceLibraryCatalog(env, {
      spaceId: repo.spaceId,
      principal: { kind: "user", id: input.actorUserId },
    });
    if (Object.keys(catalog.libraries).length) spaceLibs = catalog.libraries;
    if (Object.keys(catalog.problems).length) libraryProblems = catalog.problems;
  }
  const checked = checkNornProgram(program.source, spaceLibs || libraryProblems ? { libraries: spaceLibs, libraryProblems } : undefined);
  if ("refusal" in checked) return { refusal: `The program was not started:\n\n\`\`\`text\n${checked.refusal}\n\`\`\`` };
  const pinnedLibs = spaceLibs ? selectReferencedLibraries(program.source, spaceLibs) : undefined;
  const started = await repo.start({ requestId, channelId: input.channelId,
    programId: input.messageId, authorKind: input.senderKind, authorityUserId: input.actorUserId,
    authorId: input.senderKind === "agent" ? input.senderInstanceId ?? input.senderId : input.senderId,
    source: program.source, ledger: nornStartLedger }, nornStep(undefined, undefined, pinnedLibs && Object.keys(pinnedLibs).length ? { libraries: pinnedLibs } : undefined));
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
  const initialWork = await programs.channelWork({ requestId, channelId });
  let moreEventDeliveries = initialWork.eventDeliveries.length >= 50;
  for (const owed of initialWork.eventDeliveries) {
    const scope = { requestId: `norn-event:${owed.eventId}:${owed.programId}`, channelId, programId: owed.programId, eventId: owed.eventId };
    const payload = parseNornEventDeliveryPayload(owed.payload);
    if (!owed.running || !owed.authorityAllowed || !payload ||
        !(await nornEventDeliveryAllowed(env, { spaceId: owed.spaceId, authorityUserId: owed.authorityUserId, grant: payload.grant }))) {
      await programs.settleEventDelivery(scope);
      continue;
    }
    try {
      await programs.deliverEvent(scope, nornStep(undefined, {
        id: owed.eventId, streams: payload.streams, what: payload.what,
        ...(payload.cloudEvent ? { cloudEvent: payload.cloudEvent } : {}),
      }));
    } catch (error) {
      const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(owed.attempts, 6)));
      await programs.rescheduleEventDelivery({ ...scope, delayMs }).catch(() => undefined);
      console.warn("Norn owed outside-event delivery failed; rescheduled", {
        channelId, programId: owed.programId, attempts: owed.attempts + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const programId of initialWork.passes) {
    await programs.advance({ requestId, channelId, programId }, nornStep());
  }
  const work = await programs.channelWork({ requestId, channelId });
  if (work.eventDeliveries.length > 0) moreEventDeliveries = true;
  let undeliverable = false;
  for (const delivery of work.deliveries) {
    // A request of a connected app is the host's own: it is staged or run here, and no Agent or person is delivered it.
    const asked = delivery.request as LedgerRequest;
    if (appRequest(asked)) {
      const scope = { requestId, channelId, programId: delivery.programId };
      const preparedRef = asked.action.prepared === null ? undefined
        : await programs.requestRef({ ...scope, ledgerRequestId: asked.action.prepared });
      const outcome = await deliverNornAppRequest(env, { spaceId: programs.spaceId, channelId, authorityUserId: delivery.authorityUserId,
        request: asked, requestRef: delivery.requestRef, deliveryMessageId: delivery.deliveryMessageId, ...(preparedRef ? { preparedRef } : {}) });
      if (outcome.say) await say(env, postCommit, { channelId, messageId: delivery.deliveryMessageId, ...replyTo(delivery),
        authorityUserId: delivery.authorityUserId, quiet: true, body: outcome.say });
      if ("held" in outcome) {
        await programs.delivered({ ...scope, ledgerRequestId: delivery.requestId, epoch: delivery.epoch, hostDueInMs: outcome.held.dueInMs });
      } else {
        // It ended where it was staged: the program reads how in its next pass, which may open what follows.
        await programs.advance(scope, nornStep({ requestId: delivery.requestId, epoch: delivery.epoch, reply: outcome.reply }));
        undeliverable = true;
      }
      continue;
    }
    if (personHolder(delivery.holder)) {
      const people = await peopleNamed(programs, { requestId, channelId }, delivery.holder);
      const scope = { requestId, channelId, programId: delivery.programId };
      if (people.length !== 1) {
        await programs.advance(scope, nornStep({ requestId: delivery.requestId, epoch: delivery.epoch, reply: { tag: "Broke",
          reason: people.length ? `More than one person here is named ${delivery.holder}` : `Nobody named ${delivery.holder} can read this conversation` } }));
        undeliverable = true;
        continue;
      }
      // The card names the Agent that asks; a question asked with a command has no other message a person reads.
      const asking = nornAsking({ ...delivery, askedWithCommand: delivery.programId.startsWith(NORN_ASK_PREFIX) });
      await say(env, postCommit, { channelId, messageId: delivery.deliveryMessageId, ...replyTo(delivery),
        authorityUserId: delivery.authorityUserId, quiet: true,
        body: nornPersonBody(delivery.request as LedgerRequest, asking, delivery.delegation as Delegation | null),
        card: nornRequestCard(delivery.request as LedgerRequest, delivery.requestRef, people[0]!, asking) });
      await programs.delivered({ ...scope, ledgerRequestId: delivery.requestId, epoch: delivery.epoch, holderUserId: people[0]! });
      continue;
    }
    // A request delegated to an Instance by its address goes to that Instance, if it is still here to take it;
    // without it, the delegation fails, and the request goes back to whoever delegated it.
    if (instanceHolder(delivery.holder) && !delivery.addressed) {
      await programs.advance({ requestId, channelId, programId: delivery.programId }, nornStep({ requestId: delivery.requestId,
        epoch: delivery.epoch, reply: { tag: "Broke", reason: `${delivery.holder} no longer takes messages in this conversation` } }));
      undeliverable = true;
      continue;
    }
    const there = delivery.addressed ?? delivery.there;
    // A page's program has its conversation to itself, and its own message there is xMatrix's, which takes no reply.
    await say(env, postCommit, { channelId, messageId: delivery.deliveryMessageId, ...replyTo(delivery),
      authorityUserId: delivery.authorityUserId, ...(there ? { onlyInstanceId: there.instanceId } : {}),
      ...nornDelivery(delivery.request as LedgerRequest, delivery.requestRef,
        { ...(there ? { there: there.mention } : {}), kept: delivery.onPage, atWork: Boolean(delivery.addressed), handedOn: delivery.handedOn,
          withPerson: delivery.withPerson, delegation: delivery.delegation as Delegation | null }) });
    await programs.delivered({ requestId, channelId, programId: delivery.programId, ledgerRequestId: delivery.requestId, epoch: delivery.epoch,
      ...(there ? { instanceId: there.instanceId } : {}) });
  }
  // A request nobody could be found for ended in this pass, or more owed outside events remain: run the next page.
  if (undeliverable || moreEventDeliveries) await wakeAgentLaunchCoordinator(env, channelId, ["norn"]);
  // A person's request that ended says how under its card, and no longer waits on them.
  for (const closing of work.closings) {
    if (closing.reply) await recordCommandResult(env, { channelId, messageId: closing.deliveryMessageId, key: "norn-request",
      entry: { note: { text: nornOutcomeText(closing.holder, closing.reply as Reply, nornAsking({ authorMention: null, source: closing.source,
        askedWithCommand: closing.programId.startsWith(NORN_ASK_PREFIX) }).otherwise) } } });
    await markCardAnswered(env, channelId, closing.deliveryMessageId, closing.holderUserId);
    await programs.released({ requestId, channelId, programId: closing.programId, ledgerRequestId: closing.requestId });
  }
  // What a program says goes to its conversation as xMatrix, naming whom it is for; it starts and wakes nobody.
  for (const notice of work.notices) {
    await say(env, postCommit, { channelId, messageId: `norn-say:${notice.noticeId}`, authorityUserId: notice.authorityUserId,
      body: `${notice.recipient} ${notice.body}`.trim(), quiet: true, ...replyTo(notice) });
    await programs.noticed({ requestId, channelId, programId: notice.programId, noticeId: notice.noticeId });
  }
  for (const report of work.reports) {
    const ended = report.ended as Ledger["ended"];
    // A page's program ends in its own conversation. It wakes nobody there: one that failed by itself waits on
    // the people it worked for, and the Agent that stayed takes what they say next.
    const page = report.onPage ? nornPageEnd({ ended, requests: report.requests as Record<string, LedgerRequest> | null,
      people: report.people, authority: { userId: report.authorityUserId, name: report.authorityName } }) : undefined;
    await say(env, postCommit, { channelId, messageId: `norn-end:${report.programId}`.slice(0, 300),
      ...(page ? { quiet: true, waitsOn: page.waitsOn } : replyTo(report)),
      authorityUserId: report.authorityUserId,
      // An Agent that started the program is told by its address, so it wakes to read the result.
      body: page?.body ?? `${report.authorMention ? `${report.authorMention} ` : ""}${nornEndBody(ended)}` });
    // An approval the program asked for and never used is void with it.
    if (report.appRefs.length) await withdrawNornAppRequests(env, { spaceId: programs.spaceId, prepareRefs: report.appRefs, ended: true });
    await programs.reported({ requestId, channelId, programId: report.programId });
  }
  // An Instance started for a request has nothing left to do in the conversation once the request has ended,
  // once its Agent delegated the request to someone else, or once the request was handed on past it.
  for (const release of work.releases) {
    // A connected app's request started no Instance. One that ended unanswered leaves Pending approvals.
    if (release.holder?.startsWith("app:")) {
      if (release.requestRef) await withdrawNornAppRequests(env, { spaceId: programs.spaceId, prepareRefs: [release.requestRef] });
    } else await letGo(env, channelId, release, "Its request has ended");
    await programs.released({ requestId, channelId, programId: release.programId, ledgerRequestId: release.requestId });
  }
  for (const release of work.delegatedAway) {
    await letGo(env, channelId, release, "Its request went on to another Instance");
    await programs.letGoDelegatedAway({ requestId, channelId, programId: release.programId, ledgerRequestId: release.requestId });
  }
}

/**
 * How a request a connected app holds ended, told by whoever learned it: the
 * approval route when a Space admin answered, the durable executor when the
 * action ran. The program reads it in the same step. A request that has ended
 * already takes nothing, so a repeat is safe.
 */
export async function settleNornAppRequest(env: Env, input: { channelId: string; requestRef: string;
  outcome: { admitted: true } | { declined: string } | ProgramActionOutcome }): Promise<void> {
  const requestId = `norn-app:${input.requestRef}:${crypto.randomUUID()}`;
  const programs = await repository(env, input.channelId, requestId);
  const held = await programs.appRequest({ requestId, requestRef: input.requestRef });
  if (!held || held.channelId !== input.channelId) return;
  const { outcome } = input;
  // Only the request's own token admits it, so the reply is made from the ledger request the index names.
  const reply: Reply = "admitted" in outcome ? nornPreparedReply({ id: held.ledgerRequestId } as LedgerRequest)
    : "done" in outcome ? nornActionAnswer(outcome.done)
    : "declined" in outcome ? { tag: "Refused", reason: outcome.declined }
    : "blocked" in outcome ? { tag: "Refused", reason: outcome.blocked } : { tag: "Broke", reason: outcome.failed };
  await programs.advance({ requestId, channelId: input.channelId, programId: held.programId },
    nornStep({ requestId: held.ledgerRequestId, epoch: held.epoch, reply }));
  // What the answer opened, or the program's end, is the coordinator's to deliver.
  await wakeAgentLaunchCoordinator(env, input.channelId, ["norn"]);
}

// The durable executor tells a program how the action it performed ended. The connector's files do not import the
// Norn host, which imports them, so the host installs its part here, once both are loaded.
installProgramActionOutcome(settleNornAppRequest);

/** Stops the Run of an Instance a request started, if still live, or retires the Instance if it rests. */
async function letGo(env: Env, channelId: string, release: { programId: string; requestId: string; authorityUserId: string;
  runId: string | null; mention: string | null }, why: string): Promise<void> {
  const port = createProductAgentInterventionAuthorityPort({ env, actorUserId: release.authorityUserId,
    sourceMessageId: `norn-release:${release.programId}:${release.requestId}`.slice(0, 200) });
  const target = release.runId ? (await port.listKillTargets(channelId)).find(candidate => candidate.runId === release.runId) : undefined;
  if (target) await port.issueStop(target, `norn-release:${release.runId}`.slice(0, 200), why, channelId);
  // At rest it has no Run to stop, and the next message in the conversation would wake it.
  else if (release.mention) await port.stopResting?.(channelId, { mention: release.mention, exclude: [] });
}

/** The Run that holds a request answers it; the program reads the answer in the same step. */
export async function answerNornRequest(env: Env, input: { channelId: string; runId: string; instanceId: string; ownerUserId: string; requestRef: string;
  /** The Run as it authors a message: xMatrix posts its answer in the conversation under its name. */
  agent: { agentId: string; agentName: string; executionKey: string };
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
  if (!result.refusal) {
    // An answer to the request that started the Run is the Run's reply, as a message in the conversation is:
    // its launch is measured and judged by it. Best effort; the answer is already in the ledger.
    await runtimeRepository(env).recordAgentLaunchFirstReply({ requestId: crypto.randomUUID(), channelId: input.channelId,
      runId: input.runId, actorUserId: input.ownerUserId, at: new Date().toISOString() }).catch((error: unknown) => {
      console.warn("Norn answer could not be recorded as the Run's first reply", { channelId: input.channelId, runId: input.runId,
        error: error instanceof Error ? error.message : String(error) });
    });
    // The answer stands in the conversation as the holder's own message, where whoever follows the work reads it.
    // It is appended and not interpreted: nothing in it summons, commands or wakes. Best effort, as above.
    const messageId = `norn-answer:${input.requestRef}:${held.epoch}`;
    await dispatchProductMessageAppend(env, input.channelId, { commandId: `norn-message:${messageId}`.slice(0, 200), messageId,
      channelId: input.channelId, body: nornAnswerBody(input.outcome, input.text, result.returnedTo), principal: { kind: "agent", id: input.agent.agentId },
      senderSnapshot: { identityId: input.agent.agentId, kind: "agent", agentId: input.agent.agentId, label: input.agent.agentName,
        name: input.agent.agentName, agentName: input.agent.agentName, email: "", userId: input.ownerUserId, instanceId: input.instanceId },
      agentRunProof: { runId: input.runId, executionKey: input.agent.executionKey, instanceId: input.instanceId },
    }).then(response => { if (!response.ok) throw new Error(`append failed (${response.status})`); }).catch((error: unknown) => {
      console.warn("Norn answer could not be posted to its conversation", { channelId: input.channelId, requestRef: input.requestRef,
        error: error instanceof Error ? error.message : String(error) });
    });
    // What the answer opened, or the program's end, is the coordinator's to deliver.
    await wakeAgentLaunchCoordinator(env, input.channelId, ["norn"]);
  }
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
  // A person who was delegated the request and declines gives it back: their card is closed here, since the
  // request now has a new holding, and the one who delegated it is delivered it again.
  if (result.returnedTo) await closeCard(env, { channelId: input.channelId, messageId: held.deliveryMessageId, userId: input.userId,
    text: `Given back to ${result.returnedTo.slice(1)}: ${input.text}` });
  // The card is closed and what the answer opened is delivered by the coordinator.
  if (!result.refusal) await wakeAgentLaunchCoordinator(env, input.channelId, ["norn"]);
  return result;
}

/** A person's card that no longer waits on them, with a line saying why. */
async function closeCard(env: Env, card: { channelId: string; messageId: string; userId: string; text: string }): Promise<void> {
  await recordCommandResult(env, { channelId: card.channelId, messageId: card.messageId, key: "norn-request", entry: { note: { text: card.text } } });
  await markCardAnswered(env, card.channelId, card.messageId, card.userId);
}

/** Who delegates a request: the person it was delivered to, or the Agent Run that holds it, with its owner. */
export type NornDelegator = { kind: "person"; userId: string } | { kind: "run"; runId: string; instanceId: string; ownerUserId: string };

/**
 * The holder of a request delegates it to one participant, who answers it for
 * them (Norn spec §7): a person who can read the conversation, an Agent by its
 * name, whose new Run takes it, or an Instance here by its address. The
 * program does not see it. Returns why it cannot be, or undefined when the
 * caller holds no such open request.
 */
export async function delegateNornRequest(env: Env, input: { channelId: string; requestRef: string; to: string; reason?: string;
  delegator: NornDelegator }): Promise<NornPassResult | undefined> {
  const requestId = `norn-delegate:${input.requestRef}:${crypto.randomUUID()}`;
  const programs = await repository(env, input.channelId, requestId);
  const held = input.delegator.kind === "person"
    ? await programs.personRequest({ requestId, requestRef: input.requestRef, userId: input.delegator.userId })
      .then(row => row && row.channelId === input.channelId ? { programId: row.programId, requestId: row.ledgerRequestId, epoch: row.epoch,
        cardMessageId: row.deliveryMessageId } : undefined)
    : await programs.heldRequest({ requestId, channelId: input.channelId, requestRef: input.requestRef, runId: input.delegator.runId,
      instanceId: input.delegator.instanceId });
  if (!held) return undefined;
  const scope = { requestId, channelId: input.channelId, programId: held.programId };
  const delegatorUserId = input.delegator.kind === "person" ? input.delegator.userId : input.delegator.ownerUserId;
  const to = input.to.trim();
  let refusal: string | undefined;
  if (!/^@[^\s@:()]{1,80}(?::[1-9]\d{0,8})?$/u.test(to)) refusal = "Name one participant: a person here, an Agent such as @claude, or an Instance here such as @claude:2";
  else if (personHolder(to)) {
    const people = await peopleNamed(programs, { requestId, channelId: input.channelId }, to);
    refusal = people.length !== 1 ? (people.length ? `More than one person here is named ${to}` : `Nobody named ${to} can read this conversation`)
      : input.delegator.kind === "person" && people[0] === input.delegator.userId ? "The request is yours already" : undefined;
  } else if (instanceHolder(to) && !await programs.instanceAt({ ...scope, address: to, delegatorUserId })) {
    refusal = `${to} is not an Instance of yours, or of the program's authority, that takes messages in this conversation`;
  } else if (!instanceHolder(to) && !agentHolder(to)) refusal = `This host cannot deliver a request to ${to}`;
  if (refusal) return { status: "running", refusal };
  // An Agent whose delivery started its Run for this request has nothing left to do here once it delegated it.
  const delegatedAwayInstanceId = input.delegator.kind === "run" && "startedFor" in held && held.startedFor ? input.delegator.instanceId : undefined;
  const result = await programs.delegate({ ...scope, ledgerRequestId: held.requestId, delegatorUserId,
    ...(delegatedAwayInstanceId ? { delegatedAwayInstanceId } : {}) },
    nornStep({ requestId: held.requestId, epoch: held.epoch, delegateTo: to, ...(input.reason ? { reason: input.reason } : {}) }));
  if (!result || result.refusal) return result;
  // The delegator's card no longer waits on them: it says to whom the request went. The delegate is delivered
  // the request as a new holding by the coordinator.
  if (input.delegator.kind === "person" && "cardMessageId" in held) await closeCard(env, { channelId: input.channelId,
    messageId: held.cardMessageId, userId: input.delegator.userId, text: `${NORN_DELEGATED_NOTE}${to.slice(1)}${input.reason ? `: ${input.reason}` : ""}` });
  await wakeAgentLaunchCoordinator(env, input.channelId, ["norn"]);
  return result;
}

/**
 * The person who delegated a request takes it back while it is open: it is
 * delivered to them again, and what the delegate answers afterwards is not
 * taken. A person who held it for them sees their card closed. Returns
 * undefined when they delegated no such open request.
 */
export async function reclaimNornRequest(env: Env, input: { channelId: string; requestRef: string; userId: string }): Promise<NornPassResult | undefined> {
  const requestId = `norn-reclaim:${input.requestRef}:${crypto.randomUUID()}`;
  const programs = await repository(env, input.channelId, requestId);
  const delegated = await programs.delegatedRequest({ requestId, requestRef: input.requestRef, userId: input.userId });
  if (!delegated || delegated.channelId !== input.channelId) return undefined;
  const result = await programs.advance({ requestId, channelId: input.channelId, programId: delegated.programId },
    nornStep({ requestId: delegated.ledgerRequestId, reclaim: true }));
  if (!result || result.refusal) return result;
  if (delegated.delegate) await closeCard(env, { channelId: input.channelId, messageId: delegated.delegate.cardMessageId,
    userId: delegated.delegate.userId, text: "Taken back by the one who delegated it to you." });
  await wakeAgentLaunchCoordinator(env, input.channelId, ["norn"]);
  return result;
}

/**
 * An Agent Run asks one question without writing its program. xMatrix writes
 * the program into the Run's conversation and the Run's Instance is its
 * author: the answer comes back to it as the program's result. A person reads
 * the question once, on the card that names the asker and says how it was
 * answered; the program and its end are the asker's to read
 * (`isNornAskProgramMessage`). Returns why the question cannot be asked.
 */
export async function askNornQuestion(env: Env, run: { channelId: string; instanceId: string; ownerUserId: string; agentName: string },
  question: NornQuestion): Promise<{ refusal?: string }> {
  const built = nornQuestionSource(question);
  if ("refusal" in built) return built;
  const messageId = `${NORN_ASK_PREFIX}${crypto.randomUUID()}`, requestId = `norn-start:${messageId}`;
  // The name is written without its @: the request's own message tells whoever is asked, once.
  await say(env, async () => undefined, { channelId: run.channelId, messageId, authorityUserId: run.ownerUserId, quiet: true,
    body: `${run.agentName} asks ${question.who.slice(1)}:\n\n\`\`\`norn run\n${built.source}\n\`\`\`` });
  await (await repository(env, run.channelId, requestId)).start({ requestId, channelId: run.channelId, programId: messageId,
    authorKind: "agent", authorId: run.instanceId, authorityUserId: run.ownerUserId, source: built.source, ledger: nornStartLedger }, nornStep());
  await wakeAgentLaunchCoordinator(env, run.channelId, ["norn"]);
  return {};
}

/**
 * The Agent Run whose Instance asked a question with a command calls it off.
 * The program written for it stops in this call: the request ends
 * `Cancelled`, whoever holds it is told (a person's card says it is no longer
 * asked), and the asker reads the program's end. Returns undefined when its
 * Instance asked no such open question.
 */
export async function callOffNornQuestion(env: Env, input: { channelId: string; requestRef: string; instanceId: string }): Promise<NornPassResult | undefined> {
  const requestId = `norn-call-off:${input.requestRef}:${crypto.randomUUID()}`;
  const programs = await repository(env, input.channelId, requestId);
  const programId = await programs.callOffQuestion({ requestId, channelId: input.channelId, requestRef: input.requestRef, instanceId: input.instanceId });
  if (!programId) return undefined;
  const result = await programs.advance({ requestId, channelId: input.channelId, programId }, nornStep());
  // The card is closed, the Agent that held the request let go and the end told by the coordinator.
  await wakeAgentLaunchCoordinator(env, input.channelId, ["norn"]);
  return result ?? { status: "failed" };
}

/** The open requests a Run holds and those its Instance's programs wait on. */
export async function openNornRequests(env: Env, input: { channelId: string; runId: string; instanceId: string }) {
  const requestId = `norn-requests:${input.runId}`;
  return (await repository(env, input.channelId, requestId)).openRequests({ requestId, ...input });
}
