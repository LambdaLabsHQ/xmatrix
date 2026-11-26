import { NORN_REMOVED_FROM_PAGE, PostgresNornProgramRepository, PostgresPageRepository, readDeletedConversations, readNornProgram, readNornRequest, readPageNornPrograms } from "@xmatrix/db";
import type { NornRequestView, PageProgramStatus, PageScheduleProblem } from "@xmatrix/protocol";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { effectivelyRestricted } from "./page-restriction";
import { deterministicConversationId } from "./deterministic-id";
import {
  checkNornProgram, diffNornProgramUpgrade, nornBlocks, nornBlockSource, nornRequestWords, nornStartLedger, nornStep, pageSpaceLibraries,
  pinNornProgram, plainAnswer as answerText, plainResult as resultText, previewNornEdit, verifyNornLedgerMigration,
} from "./norn-host";
import { nornFlow } from "./norn-plan";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "./postgres-message-database-policy";
import { postgresMessageRoute } from "./postgres-message-authority";
import { dispatchProductMessageAppend } from "./product-message-append";
import { openConversation } from "./system-conversation";
import type { Env } from "./types";
import type { Ledger, LedgerRequest, MigrationStep, Reply } from "./vendor/norn/runtime/ledger";
import { text, variant } from "./vendor/norn/runtime/value";

/**
 * Programs that live on a Page (docs/architecture/norn-host.md): each
 * top-level `norn run` block is a program, the Page and the block's name are
 * its identity, and it does its work in a conversation of its own that is
 * linked to the Page. A saved revision is synced here as whoever wrote it,
 * the way the Page's schedule lines are.
 */

function database(env: Env) {
  return createPostgresAuthorityDatabase(env, { applicationName: "xmatrix-norn-page-programs",
    connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS,
    statementTimeoutMs: 5_000, transactionTimeoutMs: 15_000, lockTimeoutMs: 2_000 });
}

/** The one conversation a block works in for its whole life. */
const blockConversation = (pageId: string, name: string): Promise<string> => deterministicConversationId("norn-page-program", pageId, name);
/**
 * The blocks whose conversation a person deleted. Deleting it ended the
 * program, and its identity is never used again: the block stays as it is
 * until it is renamed, which makes it another program with another conversation.
 */
async function deletedBlocks(db: ReturnType<typeof database>, spaceId: string, pageId: string, names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set();
  const conversations = await Promise.all(names.map(async name => [name, await blockConversation(pageId, name)] as const));
  const deleted = await readDeletedConversations(db, { requestId: crypto.randomUUID(), spaceId, channelIds: conversations.map(([, id]) => id) });
  return new Set(conversations.filter(([, id]) => deleted.has(id)).map(([name]) => name));
}
const DELETED_PROBLEM = "This program's conversation was deleted, which ended it. Rename the block to run it again.";

/** What decides whether a revision changed the Page's programs. */
export const pageProgramsKey = (body: string): string => JSON.stringify(nornBlocks(body));

/** The names of Norn programs currently running on a Page (excluding blocks whose conversation was deleted). */
export async function runningPageNornPrograms(
  env: Env,
  input: { spaceId: string; pageId: string },
): Promise<Array<{ name: string }>> {
  const db = database(env);
  const programs = await readPageNornPrograms(db, {
    requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId,
  });
  const running = programs.filter(program => program.state === "running");
  if (!running.length) return [];
  const deleted = await deletedBlocks(db, input.spaceId, input.pageId, running.map(program => program.name));
  return running.filter(program => !deleted.has(program.name)).map(program => ({ name: program.name }));
}

/**
 * Makes the Page's programs what its blocks say, as `userId`: a new block
 * starts a program, a changed one revises the program it names, a removed one
 * stops it, and a block changed after its program ended runs again, as does
 * one that comes back unchanged after its removal stopped its program. A block
 * that does not check changes nothing; the Page's program status says why.
 * Every block is tried: one that cannot be brought up to date fails the sync,
 * which is then made again, without keeping the others from starting.
 */
export async function syncPagePrograms(env: Env, input: { spaceId: string; pageId: string; userId: string }): Promise<PageScheduleProblem[]> {
  const { spaceId, pageId, userId } = input;
  const db = database(env);
  const principal = { kind: "user" as const, id: userId };
  const pages = new PostgresPageRepository(db);
  const [{ page }, programs] = await Promise.all([
    pages.read({ requestId: crypto.randomUUID(), spaceId, pageId, principal }),
    readPageNornPrograms(db, { requestId: crypto.randomUUID(), spaceId, pageId }),
  ]);
  // The head may have moved past the revision that asked; its blocks are what holds now.
  const blocks = nornBlocks(page.body);
  const libraries = pageSpaceLibraries(page.body);
  const libOpts = Object.keys(libraries).length ? { libraries } : undefined;
  const repository = async (channelId: string, requestId: string) =>
    new PostgresNornProgramRepository(db, await postgresMessageRoute(env, channelId, requestId, { database: db }));

  const failures: string[] = [];
  const each = async (name: string, work: () => Promise<void>) => {
    try { await work(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  // A deleted conversation is cleared away over minutes, and its program's row with it: the program is gone at once.
  const deleted = await deletedBlocks(db, spaceId, pageId, [...new Set([...blocks, ...programs].map(item => item.name))]);
  for (const program of programs) {
    if (program.state !== "running" || deleted.has(program.name) || blocks.some(block => block.name === program.name)) continue;
    await each(program.name, async () => {
      const requestId = `norn-page-remove:${program.programId}`;
      await (await repository(program.channelId, requestId)).remove({ requestId, channelId: program.channelId, programId: program.programId });
      await wakeAgentLaunchCoordinator(env, program.channelId, ["norn"]);
    });
  }

  for (const block of blocks) await each(block.name, async () => {
    const current = programs.find(program => program.name === block.name);
    // A block that left the Page and came back unchanged (a bad edit, then its undo) is not done with:
    // a removal its program has not ended on yet is called off, and one it ended on runs it again.
    const removed = current !== undefined && (current.state === "running" ? current.stopReason === NORN_REMOVED_FROM_PAGE
      : (current.ledger as Ledger | null | undefined)?.ended?.error === NORN_REMOVED_FROM_PAGE);
    if (block.problem || (current?.source === block.source && !removed) || deleted.has(block.name)
      || "refusal" in checkNornProgram(block.source, libOpts)) return;
    if (current?.state === "running" && removed) {
      const requestId = `norn-page-restore:${current.programId}:${crypto.randomUUID()}`;
      await (await repository(current.channelId, requestId)).restore({ requestId, channelId: current.channelId, programId: current.programId });
      await wakeAgentLaunchCoordinator(env, current.channelId, ["norn"]);
      if (current.source === block.source) return;
    }
    if (current?.state === "running") {
      const requestId = `norn-page-revise:${current.programId}:${crypto.randomUUID()}`;
      await (await repository(current.channelId, requestId)).revise({ requestId, channelId: current.channelId,
        programId: current.programId, source: block.source, authorityUserId: userId }, nornStep(undefined, undefined, libOpts));
      await wakeAgentLaunchCoordinator(env, current.channelId, ["norn"]);
      return;
    }
    // One conversation for the block's whole life; each run of its program is a message there.
    const channelId = await blockConversation(pageId, block.name);
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
      authorityUserId: userId, source: block.source, page: { pageId, name: block.name }, ledger: nornStartLedger }, nornStep(undefined, undefined, libOpts));
    await wakeAgentLaunchCoordinator(env, channelId, ["norn"]);
  });
  if (failures.length) throw new Error(failures.join("; "));
  // What only the sync can know, for whoever saved: the blocks whose conversation was deleted.
  return blocks.filter(block => !block.problem && deleted.has(block.name))
    .map(block => ({ source: nornBlockSource(block.name, block.edition), problem: DELETED_PROBLEM }));
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
  return { ref: input.requestRef, channelId: found.channelId, ...nornRequestWords(request),
    state: request.reply === null ? "open" : OUTCOMES[request.reply.tag],
    reply: request.reply === null ? null : request.reply.tag === "Answered" ? answerText(request.reply.value)
      : "reason" in request.reply ? request.reply.reason : null,
    ...(found.delegatedByReader ? { yoursToTakeBack: true } : {}) };
}

/**
 * How a program stands for whoever reads it: its requests so far, how it
 * ended, and what it does from here on. `source` is the text to read the
 * rest from: the block as it is written now, which a program that has not
 * started is read from too.
 */
function programStatus(name: string, source: string, problem: string | undefined,
  program: { channelId: string; state: string; ledger: unknown } | undefined,
  libraries?: Readonly<Record<string, string>>): PageProgramStatus {
  const ledger = program?.ledger as (Ledger & { pinnedLibraries?: Record<string, string> }) | undefined;
  const activeLibraries = libraries && Object.keys(libraries).length ? libraries : ledger?.pinnedLibraries;
  const checked = problem === undefined ? checkNornProgram(source, activeLibraries ? { libraries: activeLibraries } : undefined) : { refusal: problem };
  const now = Date.now();
  return {
    name,
    ...(program ? { channelId: program.channelId } : {}),
    state: program ? program.state as PageProgramStatus["state"] : "not_started",
    ...("refusal" in checked ? { problem: checked.refusal } : {}),
    ...(ledger?.ended ? { result: ledger.ended.error ?? (ledger.ended.result ? resultText(ledger.ended.result) : "") } : {}),
    requests: Object.values(ledger?.requests ?? {}).sort((a, b) => a.openedAt - b.openedAt).map(request => ({
      ...nornRequestWords(request), askedAt: new Date(request.openedAt).toISOString(),
      by: request.by === null ? null : new Date(request.by).toISOString(),
      outcome: request.reply === null ? null : OUTCOMES[request.reply.tag],
      reply: request.reply === null ? null : request.reply.tag === "Answered" ? answerText(request.reply.value)
        : "reason" in request.reply ? request.reply.reason : null,
      settledAt: request.settledAt === null ? null : new Date(request.settledAt).toISOString() })),
    next: "refusal" in checked ? [] : nornFlow(checked.code, ledger ?? nornStartLedger(now), now),
  };
}

/** How each program block of a Page stands, for whoever can read the Page. The caller has read `body` as them. */
export async function pageProgramStatus(env: Env, input: { spaceId: string; pageId: string; body: string }): Promise<PageProgramStatus[]> {
  const db = database(env);
  const programs = await readPageNornPrograms(db, { requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId });
  const blocks = nornBlocks(input.body);
  const libraries = pageSpaceLibraries(input.body);
  const deleted = await deletedBlocks(db, input.spaceId, input.pageId, blocks.map(block => block.name));
  return blocks.map(block => programStatus(block.name, block.source,
    block.problem ?? (deleted.has(block.name) ? DELETED_PROBLEM : undefined),
    // A deleted conversation is cleared away over minutes: its program is gone from the page at once.
    deleted.has(block.name) ? undefined : programs.find(candidate => candidate.name === block.name),
    libraries));
}

function sampleReplyFor(request: LedgerRequest): Reply {
  if (request.verb === "confirm") return { tag: "Answered", value: variant("Yes") };
  if (request.verb === "choose" && request.options?.length) return { tag: "Answered", value: request.options[0]! };
  if (request.verb === "judge") return { tag: "Answered", value: { type: "bool", value: true } };
  if (request.verb === "ask") return { tag: "Answered", value: text("preview-sample") };
  if (request.form === null) return { tag: "Answered", value: { type: "record", fields: { text: text("preview-sample") } } };
  return { tag: "Refused", reason: "preview-sample" };
}

function summarizePreview(preview: ReturnType<typeof previewNornEdit>) {
  if ("refusal" in preview) return preview;
  return {
    empty: preview.empty,
    openedCount: preview.opened.length,
    keptCount: preview.kept.length,
    unreachedCount: preview.unreached.length,
    answeredUnusedCount: preview.answeredUnused.length,
    rescheduledCount: preview.rescheduled.length,
    formChangedCount: preview.formChanged.length,
    incompatibleAnswersCount: preview.incompatibleAnswers.length,
    nextDue: preview.nextDue,
    loops: preview.loops.map(l => ({ key: l.key, status: l.status, sealedRounds: l.sealedRounds, beforeNextDue: l.beforeNextDue, afterNextDue: l.afterNextDue })),
  };
}

function summarizeUpgrade(upgrade: ReturnType<typeof diffNornProgramUpgrade>) {
  if ("refusal" in upgrade) return upgrade;
  return {
    beforeOk: upgrade.beforeOk,
    afterOk: upgrade.afterOk,
    definitionChanged: upgrade.definitionChanged,
    requiresExplicitAdoption: upgrade.requiresExplicitAdoption,
    effects: upgrade.effects,
    interfaces: upgrade.interfaces.map(i => ({ library: i.library, change: i.change, definitionChanged: i.definitionChanged })),
  };
}

function summarizeMigration(result: ReturnType<typeof verifyNornLedgerMigration>) {
  if ("refusal" in result) return result;
  const { migration, report } = result;
  // Never return the raw migrated ledger copy (which contains private replies/occurrences) to a Page reader.
  return {
    ok: Boolean(migration.ok && report?.ok),
    verified: Boolean(report?.verified),
    keepLegacy: migration.keepLegacy,
    ...(migration.ok ? { migratedRequests: migration.migratedRequests, migratedLoops: migration.migratedLoops } : { reason: migration.reason }),
    stepsExecuted: report?.stepsExecuted ?? 0,
    legacyDispatchedCount: report?.legacyDispatched.length ?? 0,
    migratedDispatchedCount: report?.migratedDispatched.length ?? 0,
    differences: report?.differences ?? (migration.ok ? [] : [migration.reason]),
  };
}

/**
 * Read-only preview of a proposed Page edit (or live migration readiness of the
 * current Page): returns redacted counts, SHA-256 definition pins, 3-way
 * upgrade categories, and forward-advancing v1-to-v2 migration verification
 * without mutating any ledger or exposing raw ledger contents.
 */
export async function pageProgramPreview(
  env: Env,
  input: { spaceId: string; pageId: string; currentBody: string; proposedBody?: string },
): Promise<unknown[]> {
  const db = database(env);
  const programs = await readPageNornPrograms(db, { requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId });
  const nextBody = input.proposedBody ?? input.currentBody;
  const blocks = nornBlocks(nextBody);
  const afterLibraries = pageSpaceLibraries(nextBody);
  const beforePageLibraries = pageSpaceLibraries(input.currentBody);
  const now = Date.now();
  return blocks.map(block => {
    const current = programs.find(candidate => candidate.name === block.name);
    const ledger = (current?.ledger ?? nornStartLedger(now)) as Ledger & { pinnedLibraries?: Record<string, string> };
    const beforeSource = current?.source ?? block.source;
    const beforeLibraries = ledger.pinnedLibraries ?? beforePageLibraries;
    const preview = previewNornEdit(beforeSource, block.source, ledger, now, { beforeLibraries, afterLibraries });
    const upgrade = diffNornProgramUpgrade(
      { source: beforeSource, libraries: beforeLibraries },
      { source: block.source, libraries: afterLibraries },
      ledger,
      now,
    );
    let migrationSummary: unknown = undefined;
    if ((ledger.identityScheme ?? 1) === 1) {
      const steps: MigrationStep[] = [{ kind: "restart", at: now + 1 }];
      const openRequests = Object.values(ledger.requests).filter(r => r.reply === null && !r.detached && r.verb !== "spawn");
      let t = now + 2;
      for (const req of openRequests) {
        steps.push({ kind: "reply", requestId: req.id, holder: req.candidates?.[0] ?? req.holder, epoch: req.epoch, reply: sampleReplyFor(req), at: t++ });
      }
      steps.push({ kind: "restart", at: t++ });
      if (!("refusal" in preview) && preview.nextDue.before !== null) {
        steps.push({ kind: "advance", at: Math.max(t, preview.nextDue.before) });
      }
      migrationSummary = summarizeMigration(
        verifyNornLedgerMigration(beforeSource, ledger, now, steps, { libraries: beforeLibraries }),
      );
    }
    return {
      name: block.name,
      pin: pinNornProgram(block.source, afterLibraries),
      preview: summarizePreview(preview),
      upgrade: summarizeUpgrade(upgrade),
      ...(migrationSummary !== undefined ? { migration: migrationSummary } : {}),
    };
  });
}

/**
 * How the program a message carries stands, for whoever can read its
 * conversation: the message is the program's identity, whether a person or an
 * Agent wrote it or xMatrix wrote it for a Page's block. Undefined for anyone
 * else, and for a message that is no program.
 */
export async function messageProgramStatus(env: Env, input: { spaceId: string; programId: string; userId: string }): Promise<PageProgramStatus | undefined> {
  const program = await readNornProgram(database(env), { requestId: crypto.randomUUID(), ...input });
  return program && programStatus(program.name ?? "main", program.source, undefined, program);
}
