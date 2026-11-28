import { PageControlError, PostgresPageRepository } from "@xmatrix/db";
import { PAGE_RESULT_KINDS, pageLineDiff, postgresJsonText, sliceCodeUnitsSafe, TEXT_TASK_INPUT_MAX_BYTES, utf8ByteLength,
  type PageDocument, type PageResultKind } from "@xmatrix/protocol";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "./postgres-message-database-policy";
import { issueTextTask, textTaskMachines, type TextTaskMachine } from "./text-task-machines";
import { retryablePostgresFailure } from "./postgres-error-classification";
import type { Env } from "./types";

/**
 * A page's summary is written by one execution of an Agent's harness on one of
 * the Space's Machines, started fresh for one revision of one page. It is
 * handed the page's text and what changed in it since the summary was last
 * written, and nothing else (no token, no tools, no conversation). It answers
 * two lines: how the page stands, and what that change resulted in. The Hub
 * writes both if the page is still at the revision that was read. It is not a
 * Run: nothing addresses it, authorizes it or outlives it, and its machine
 * command is its only record.
 */
const INSTRUCTION = [
  "You keep one page's summary current, and say what its last change resulted in.",
  "The input begins with the lines the change added (+) and took out (-), between <changed> and </changed>; the page as it is now follows.",
  "Line 1: how this page stands now, in one line of at most 100 characters: its current state, decisions in force and what is open, not its history and not what the page is for.",
  "Line 2: what the change resulted in, for a reader who was away: one of the words shipped, decided, problem, fixed, number or none, then a colon and one sentence of at most 60 characters naming the thing and what happened to it.",
  "shipped: something was released or went live. decided: a decision was made. problem: something broke, slipped or is at risk, and is not solved. fixed: a problem was solved. number: a figure that matters moved.",
  "none: bookkeeping, rewording, a routine log, or nothing a reader who was away needs; then line 2 is only the word none.",
  "Write both lines in the language the page is written in, with no heading, labels, quotes, markdown or blank lines.",
  "Answer with those two lines only.",
].join(" ");

const REQUEST = /^page-summary:([^:]{1,120}):([^:]{1,120}):([1-9][0-9]{0,15}):[0-9a-f-]{36}$/u;
export const PAGE_SUMMARY_MAX_CHARACTERS = 240;

/** The Run's id names what it summarises, so its answer needs no other record to find its page. */
export function pageSummaryRequest(requestId: string): { spaceId: string; pageId: string; revision: number } | null {
  const match = REQUEST.exec(requestId);
  return match ? { spaceId: match[1]!, pageId: match[2]!, revision: Number(match[3]) } : null;
}

/** One line, whatever the harness wrapped it in. */
export function pageSummaryLine(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim().replace(/^["'“”「『]+|["'“”」』]+$/gu, "").trim();
  return [...line].slice(0, PAGE_SUMMARY_MAX_CHARACTERS).join("");
}

const RESULT_LINE = new RegExp(`^(${PAGE_RESULT_KINDS.join("|")})\\s*[:：]\\s*(.+)$`, "iu");
const NO_RESULT_LINE = /^none\b/iu;
/** A harness that numbers its lines anyway. */
const unlabelled = (line: string) => line.replace(/^(?:line\s*[12]\s*[:：]\s*|[12][.)、]\s+)/iu, "").trim();

/**
 * What a summary execution answered: the page's line, and what the change resulted in when its second
 * line names one. An answer of one line is the summary alone, and `none` or a line that is no result
 * leaves the change without one.
 */
export function pageSummaryAnswer(text: string): { line: string; result: { kind: PageResultKind; text: string } | null } {
  const lines = text.split(/\r?\n/u).map(unlabelled).filter(Boolean);
  const at = lines.findIndex((line, index) => index > 0 && (RESULT_LINE.test(line) || NO_RESULT_LINE.test(line)));
  const match = at === -1 ? null : RESULT_LINE.exec(lines[at]!);
  const sentence = match ? pageSummaryLine(match[2]!) : "";
  return { line: pageSummaryLine((at === -1 ? lines : lines.slice(0, at)).join(" ")),
    result: match && sentence ? { kind: match[1]!.toLowerCase() as PageResultKind, text: sentence } : null };
}

/** The most of a change the task is shown; the page itself has the rest of the room. */
const CHANGED_MAX_CODE_UNITS = 24_000;

/** What a change did to a page, as the lines it added (+) and took out (-), in the page's order. */
export function pageSummaryChange(before: string, after: string): string {
  const lines = pageLineDiff(before, after).flatMap((part) => part.kind === "same" ? []
    : part.lines.filter((line) => line.trim()).map((line) => `${part.kind === "added" ? "+" : "-"} ${line}`));
  return sliceCodeUnitsSafe(lines.join("\n"), CHANGED_MAX_CODE_UNITS);
}

/**
 * What the Run reads: the change first, then the page's document, its name opening it, cut at a
 * character boundary when the two are longer than a task carries.
 */
export function pageSummaryInput(body: string, changed = ""): string {
  const head = `<changed>\n${postgresJsonText(changed)}\n</changed>\n\n`;
  let input = postgresJsonText(body);
  while (utf8ByteLength(head) + utf8ByteLength(input) > TEXT_TASK_INPUT_MAX_BYTES) {
    input = sliceCodeUnitsSafe(input, Math.floor(input.length * 0.9));
  }
  return head + input;
}

export function summaryPages(env: Env): PostgresPageRepository {
  return new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-page-summary", connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS,
    statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
}

export type PageSummaryStart = { started: true; requestId: string; revision: number }
  | { started: false; reason: "current" | "tried" | "empty" | "no_machine" };

/** Read preparation can be repeated; issuing must replay the same command, never a new task. */
async function retrySummaryDatabase<T>(phase: "prepare" | "issue", work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (!retryablePostgresFailure(error)) throw error;
    console.warn("Page summary database retry", { phase });
    return work();
  }
}

/**
 * Starts the summary of a page whose head has none yet, on the first of the
 * Space's enabled Agents whose Machine is online and can take a text task,
 * and whose owner may currently read the page, including its ancestors.
 * With none, nothing starts: the page keeps the line it has. A revision is
 * tried once (`triedRevision`), so a harness that fails on it is not asked
 * again until the page changes.
 */
export async function startPageSummary(env: Env, input: { spaceId: string; pageId: string; triedRevision?: number }):
  Promise<PageSummaryStart> {
  const prepared = await retrySummaryDatabase("prepare", () => preparePageSummary(env, input));
  if (!prepared.started) return prepared;
  const { machine, requestId, revision, body, changed } = prepared;
  const task = { requestId, instruction: INSTRUCTION, input: pageSummaryInput(body, changed) };
  // issueTextTask derives both the command id and control id from requestId.
  // A lost command receipt therefore replays its durable result, even if the
  // first attempt committed and already woke the daemon.
  await retrySummaryDatabase("issue", () => issueTextTask(env, machine, task));
  return { started: true, requestId, revision };
}

async function preparePageSummary(env: Env, input: { spaceId: string; pageId: string; triedRevision?: number }):
  Promise<Extract<PageSummaryStart, { started: false }> |
    { started: true; machine: TextTaskMachine; requestId: string; revision: number; body: string; changed: string }> {
  const pages = summaryPages(env);
  for await (const machine of textTaskMachines(env, input.spaceId, "page-summary")) {
    // A Machine is its owner's environment. Read through the ordinary page
    // authority as that owner before disclosing any text to its harness.
    let source: PageDocument;
    try {
      ({ page: source } = await pages.read({ requestId: crypto.randomUUID(), spaceId: input.spaceId,
        pageId: input.pageId, principal: { kind: "user", id: machine.ownerUserId } }));
    } catch (error) {
      if (error instanceof PageControlError && error.status === 404) continue;
      throw error;
    }
    if (source.summary?.revision === source.headRevision) return { started: false, reason: "current" };
    if (input.triedRevision === source.headRevision) return { started: false, reason: "tried" };
    if (!source.body.trim()) return { started: false, reason: "empty" };
    // The change is what the page gained and lost since its summary was last written, or since the
    // revision before this one when it has none: the same span `recordSummary` gives the result's section from.
    const from = source.summary?.revision ?? source.headRevision - 1;
    const before = from >= 1 && from < source.headRevision ? (await pages.read({ requestId: crypto.randomUUID(),
      spaceId: input.spaceId, pageId: input.pageId, principal: { kind: "user", id: machine.ownerUserId }, revision: from })).page.body : "";
    const requestId = `page-summary:${input.spaceId}:${input.pageId}:${source.headRevision}:${crypto.randomUUID()}`;
    return { started: true, machine, requestId, revision: source.headRevision, body: source.body,
      changed: pageSummaryChange(before, source.body) };
  }
  return { started: false, reason: "no_machine" };
}
