import { PostgresNornProgramRepository, PostgresPageRepository, readNornRequest, readPageNornPrograms } from "@xmatrix/db";
import type { NornRequestView, PageProgramStatus } from "@xmatrix/protocol";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { effectivelyRestricted } from "./automation-occurrence-conversation";
import { deterministicConversationId } from "./deterministic-id";
import { checkNornProgram, nornBlocks, nornStartLedger, nornStep, plainAnswer as answerText, plainResult as resultText } from "./norn-host";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { postgresMessageRoute } from "./postgres-message-authority";
import { dispatchProductMessageAppend } from "./product-message-append";
import { openConversation } from "./system-conversation";
import type { Env } from "./types";
import type { Ledger, LedgerRequest } from "./vendor/norn/runtime/ledger";

/**
 * Programs that live on a Page (docs/architecture/norn-host.md): each
 * top-level `norn run` block is a program, the Page and the block's name are
 * its identity, and it does its work in a conversation of its own that is
 * linked to the Page. A saved revision is synced here as whoever wrote it,
 * the way the Page's schedule lines are.
 */

function database(env: Env) {
  return createPostgresAuthorityDatabase(env, { applicationName: "xmatrix-norn-page-programs",
    statementTimeoutMs: 5_000, transactionTimeoutMs: 15_000, lockTimeoutMs: 2_000 });
}

/** The named blocks of a Page's text. A name used twice names nothing: neither block runs until one is renamed. */
function pageBlocks(body: string) {
  const blocks = nornBlocks(body);
  const count = new Map<string, number>();
  for (const block of blocks) count.set(block.name, (count.get(block.name) ?? 0) + 1);
  return blocks.map(block => ({ ...block, duplicate: count.get(block.name)! > 1 }));
}

/** What decides whether a revision changed the Page's programs. */
export const pageProgramsKey = (body: string): string => JSON.stringify(nornBlocks(body));

/**
 * Makes the Page's programs what its blocks say, as `userId`: a new block
 * starts a program, a changed one revises the program it names, a removed one
 * stops it, and a block changed after its program ended runs again. A block
 * that does not check changes nothing; the Page's program status says why.
 */
export async function syncPagePrograms(env: Env, input: { spaceId: string; pageId: string; userId: string }): Promise<void> {
  const { spaceId, pageId, userId } = input;
  const db = database(env);
  const principal = { kind: "user" as const, id: userId };
  const pages = new PostgresPageRepository(db);
  const [{ page }, programs] = await Promise.all([
    pages.read({ requestId: crypto.randomUUID(), spaceId, pageId, principal }),
    readPageNornPrograms(db, { requestId: crypto.randomUUID(), spaceId, pageId }),
  ]);
  // The head may have moved past the revision that asked; its blocks are what holds now.
  const blocks = pageBlocks(page.body);
  const repository = async (channelId: string, requestId: string) =>
    new PostgresNornProgramRepository(db, await postgresMessageRoute(env, channelId, requestId, { database: db }));

  for (const program of programs) {
    if (program.state !== "running" || blocks.some(block => block.name === program.name)) continue;
    const requestId = `norn-page-remove:${program.programId}`;
    await (await repository(program.channelId, requestId)).remove({ requestId, channelId: program.channelId, programId: program.programId });
    await wakeAgentLaunchCoordinator(env, program.channelId, ["norn"]);
  }

  for (const block of blocks) {
    const current = programs.find(program => program.name === block.name);
    if (block.duplicate || current?.source === block.source || "refusal" in checkNornProgram(block.source)) continue;
    if (current?.state === "running") {
      const requestId = `norn-page-revise:${current.programId}:${crypto.randomUUID()}`;
      await (await repository(current.channelId, requestId)).revise({ requestId, channelId: current.channelId,
        programId: current.programId, source: block.source, authorityUserId: userId }, nornStep());
      await wakeAgentLaunchCoordinator(env, current.channelId, ["norn"]);
      continue;
    }
    // One conversation for the block's whole life; each run of its program is a message there.
    const channelId = await deterministicConversationId("norn-page-program", pageId, block.name);
    await openConversation(env, { spaceId, channelId, name: `${page.title} · ${block.name}`,
      mode: await effectivelyRestricted(env, spaceId, pageId, userId) ? "closed" : "open",
      metadata: { createdBy: "norn-page-program", nornPageId: pageId, nornProgramName: block.name }, userId });
    await pages.link({ requestId: crypto.randomUUID(), spaceId, principal, conversationId: channelId, pageId, blockId: "",
      source: "reference" });
    const run = (current?.runs ?? 0) + 1;
    const programId = `norn-page:${await deterministicConversationId("norn-page-run", pageId, block.name, String(run))}`;
    // The program's own message: its requests and its result are replies to it. A fence tagged `norn` only shows.
    const response = await dispatchProductMessageAppend(env, channelId, { commandId: `norn-page-run:${programId}`.slice(0, 200),
      messageId: programId, channelId, principal, xmatrixAuthor: true,
      // The conversation is named for the page and the block, and links the page: the message is the source alone.
      body: `${run > 1 ? `Run ${run}.\n\n` : ""}\`\`\`norn\n${block.source}\n\`\`\`` });
    if (!response.ok) throw new Error(`Norn page program message append failed (${response.status})`);
    const requestId = `norn-page-start:${programId}`;
    await (await repository(channelId, requestId)).start({ requestId, channelId, programId, authorKind: "user", authorId: userId,
      authorityUserId: userId, source: block.source, page: { pageId, name: block.name }, ledger: nornStartLedger }, nornStep());
    await wakeAgentLaunchCoordinator(env, channelId, ["norn"]);
  }
}

const OUTCOMES = { Answered: "answered", Refused: "refused", Broke: "broke", NoReply: "no_reply", Cancelled: "cancelled",
  Revoked: "revoked" } as const;

/**
 * What a `request:<ref>` shows in place of the reference: the request itself,
 * for whoever can read its conversation. Undefined for anyone else, and for
 * a reference that names nothing.
 */
export async function nornRequestView(env: Env, input: { spaceId: string; requestRef: string; userId: string }): Promise<NornRequestView | undefined> {
  const found = await readNornRequest(database(env), { requestId: crypto.randomUUID(), ...input });
  const request = found?.request as LedgerRequest | null | undefined;
  if (!found || !request) return undefined;
  return { ref: input.requestRef, channelId: found.channelId, holder: request.holder, text: request.text,
    state: request.reply === null ? "open" : OUTCOMES[request.reply.tag],
    reply: request.reply === null ? null : request.reply.tag === "Answered" ? answerText(request.reply.value)
      : "reason" in request.reply ? request.reply.reason : null };
}

/** How each program block of a Page stands, for whoever can read the Page. The caller has read `body` as them. */
export async function pageProgramStatus(env: Env, input: { spaceId: string; pageId: string; body: string }): Promise<PageProgramStatus[]> {
  const programs = await readPageNornPrograms(database(env), { requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId });
  return pageBlocks(input.body).map(block => {
    const program = programs.find(candidate => candidate.name === block.name);
    const checked = block.duplicate ? { refusal: `Two blocks are named ${block.name}; rename one.` } : checkNornProgram(block.source);
    const ledger = program?.ledger as Ledger | undefined;
    return {
      name: block.name,
      ...(program ? { channelId: program.channelId } : {}),
      state: program ? program.state as PageProgramStatus["state"] : "not_started",
      ...("refusal" in checked ? { problem: checked.refusal } : {}),
      ...(ledger?.ended ? { result: ledger.ended.error ?? (ledger.ended.result ? resultText(ledger.ended.result) : "") } : {}),
      requests: Object.values(ledger?.requests ?? {}).sort((a, b) => a.openedAt - b.openedAt).map(request => ({
        holder: request.holder, text: request.text, askedAt: new Date(request.openedAt).toISOString(),
        by: request.by === null ? null : new Date(request.by).toISOString(),
        outcome: request.reply === null ? null : OUTCOMES[request.reply.tag],
        reply: request.reply === null ? null : request.reply.tag === "Answered" ? answerText(request.reply.value)
          : "reason" in request.reply ? request.reply.reason : null,
        settledAt: request.settledAt === null ? null : new Date(request.settledAt).toISOString() })),
    };
  });
}
