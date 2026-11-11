import { ControlError, PostgresNornProgramRepository, XMATRIX_SYSTEM_AUTHOR_ID } from "@xmatrix/db";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { checkNornProgram, nornDeliveryBody, nornEndBody, nornProgramIn, nornStartLedger, nornStep, type NornPassResult } from "./norn-host";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { postgresMessageRoute } from "./postgres-message-authority";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { ProductMessagePostCommitInput } from "./product-message-post-commit";
import type { Env } from "./types";
import type { Ledger, LedgerRequest, Reply } from "./vendor/norn/runtime/ledger";

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
  authorityUserId: string; programId: string }): Promise<void> {
  const response = await dispatchProductMessageAppend(env, input.channelId, {
    commandId: `norn-message:${input.messageId}`.slice(0, 200), messageId: input.messageId, channelId: input.channelId,
    body: input.body, principal: { kind: "user", id: input.authorityUserId }, xmatrixAuthor: true, launch: true,
    residual: { replyToMessageId: input.programId },
  });
  if (!response.ok) throw new Error(`Norn message append failed (${response.status})`);
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
  for (const delivery of work.deliveries) {
    await say(env, postCommit, { channelId, messageId: delivery.deliveryMessageId, programId: delivery.programId,
      authorityUserId: delivery.authorityUserId, body: nornDeliveryBody(delivery.request as LedgerRequest, delivery.requestRef) });
    await programs.delivered({ requestId, channelId, programId: delivery.programId, ledgerRequestId: delivery.requestId, epoch: delivery.epoch });
  }
  for (const report of work.reports) {
    // An Agent that started the program is told by its address, so it wakes to read the result.
    await say(env, postCommit, { channelId, messageId: `norn-end:${report.programId}`.slice(0, 300), programId: report.programId,
      authorityUserId: report.authorityUserId,
      body: `${report.authorMention ? `${report.authorMention} ` : ""}${nornEndBody(report.ended as Ledger["ended"])}` });
    await programs.reported({ requestId, channelId, programId: report.programId });
  }
}

/** The Run that holds a request answers it; the program reads the answer in the same step. */
export async function answerNornRequest(env: Env, input: { channelId: string; runId: string; requestRef: string;
  outcome: "answered" | "refused" | "broke"; text: string }): Promise<NornPassResult> {
  const requestId = `norn-answer:${input.requestRef}:${crypto.randomUUID()}`;
  const programs = await repository(env, input.channelId, requestId);
  const held = await programs.heldRequest({ requestId, channelId: input.channelId, requestRef: input.requestRef, runId: input.runId })
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

/** The open requests a Run holds and those its Instance's programs wait on. */
export async function openNornRequests(env: Env, input: { channelId: string; runId: string; instanceId: string }) {
  const requestId = `norn-requests:${input.runId}`;
  return (await repository(env, input.channelId, requestId)).openRequests({ requestId, ...input });
}
