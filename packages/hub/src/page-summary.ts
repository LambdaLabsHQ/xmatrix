import { PostgresMachineControlRepository, PostgresPageRepository } from "@xmatrix/db";
import { MACHINE_TEXT_TASK_CAPABILITY, TEXT_TASK_HARNESSES, TEXT_TASK_INPUT_MAX_BYTES, utf8ByteLength } from "@xmatrix/protocol";
import { registrationQuotaProbeTargetReader } from "./agent-routing-quota-refresh";
import { machineDaemonCommand, machineDatabase } from "./machines";
import { createPostgresAuthorityDatabase, createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "./postgres-authority-http";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "./postgres-message-database-policy";
import type { Env } from "./types";

/**
 * A page's summary is written by one execution of an Agent's harness on one of
 * the Space's Machines, started fresh for one revision of one page. It is
 * handed the page's text and nothing else (no token, no tools, no
 * conversation) and answers one line; the Hub writes that line to the page if
 * the page is still at the revision that was read. It is not a Run: nothing
 * addresses it, authorizes it or outlives it, and its machine command is its
 * only record.
 */
const INSTRUCTION = [
  "You keep one page's summary current.",
  "Say how this page stands now in one line: its current state, decisions in force and what is open, not its history and not what the page is for.",
  "Write it in the language the page is written in, in at most 100 characters, with no heading, quotes, markdown or line breaks.",
  "Answer with that line only.",
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

/** The page's text as the Run reads it, cut at a character boundary when it is longer than a task carries. */
export function pageSummaryInput(title: string, body: string): string {
  let input = `# ${title}\n\n${body}`;
  while (utf8ByteLength(input) > TEXT_TASK_INPUT_MAX_BYTES) input = input.slice(0, Math.floor(input.length * 0.9));
  return input;
}

export function summaryPages(env: Env): PostgresPageRepository {
  return new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-page-summary", connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS,
    statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
}

export type PageSummaryStart = { started: true; requestId: string; revision: number }
  | { started: false; reason: "current" | "tried" | "empty" | "no_machine" | "missing" };

/**
 * Starts the summary of a page whose head has none yet, on the first of the
 * Space's enabled Agents whose Machine is online and can take a text task.
 * With none, nothing starts: the page keeps the line it has. A revision is
 * tried once (`triedRevision`), so a harness that fails on it is not asked
 * again until the page changes.
 */
export async function startPageSummary(env: Env, input: { spaceId: string; pageId: string; triedRevision?: number }):
  Promise<PageSummaryStart> {
  const source = await summaryPages(env).summarySource({ requestId: crypto.randomUUID(), spaceId: input.spaceId,
    pageId: input.pageId });
  if (!source) return { started: false, reason: "missing" };
  if (source.summaryRevision === source.headRevision) return { started: false, reason: "current" };
  if (input.triedRevision === source.headRevision) return { started: false, reason: "tried" };
  if (!source.body.trim()) return { started: false, reason: "empty" };
  const database = createPostgresAuthorityDatabase(env, { applicationName: "xmatrix-page-summary-targets",
    connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS, statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000,
    lockTimeoutMs: 2_000 });
  const directory = createPostgresAuthorityFleet(env, { applicationName: "xmatrix-page-summary-targets",
    ...POSTGRES_AUTHORITY_TIMEOUTS }).directoryDatabase;
  const targets = (await registrationQuotaProbeTargetReader(database, directory)(input.spaceId))
    .filter((target) => TEXT_TASK_HARNESSES.includes(target.harness));
  const machines = new PostgresMachineControlRepository(machineDatabase(env));
  const requestId = `page-summary:${input.spaceId}:${input.pageId}:${source.headRevision}:${crypto.randomUUID()}`;
  for (const target of targets) {
    const route = { ownerUserId: target.ownerUserId, machineId: target.machineId, hostId: target.hostId };
    const { daemon } = await machines.getDaemon({ requestId, ...route });
    if (!daemon || daemon.status !== "online" || !daemon.capabilities.includes(MACHINE_TEXT_TASK_CAPABILITY)) continue;
    await machineDaemonCommand(env, {
      ...route, ownerEmail: daemon.email, daemonId: daemon.id,
      commandId: `issue:${requestId}`, action: "issue", controlId: requestId, commandType: "text_task",
      principal: { kind: "user", id: route.ownerUserId },
      payload: { type: "machine_text_task", requestId, presetId: target.harness, instruction: INSTRUCTION,
        input: pageSummaryInput(source.title, source.body) },
    });
    return { started: true, requestId, revision: source.headRevision };
  }
  return { started: false, reason: "no_machine" };
}
