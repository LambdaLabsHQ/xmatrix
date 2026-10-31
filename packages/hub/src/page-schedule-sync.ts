import { PostgresAutomationRepository, PostgresPageRepository } from "@xmatrix/db";
import {
  AUTOMATION_MAX_INTERVAL_MINUTES, markScheduleDone, pageSchedules, scheduleTimeInRange, type AutomationTrigger, type PageSchedule,
} from "@xmatrix/protocol";
import { githubConnectionInstallationFor } from "./app-connectors";
import { findAppConnection } from "./apps";
import { automationEvaluatorBinding } from "./automation-evaluator-binding";
import { effectivelyRestricted } from "./automation-occurrence-conversation";
import { commitAutomation } from "./automations";
import { deterministicConversationId } from "./deterministic-id";
import { commandPayload, expressionPayload, hubBoundary, type AutomationRecord } from "./index-routes-automation";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { createChannel } from "./spaces";
import { sessionCall } from "./index-routes-pages";
import { notifyWorkspaceResource } from "./workspace-resource-notification";
import type { Env } from "./types";

/**
 * A page's schedules are lines of its text (docs/design/pages-live-document.md
 * §6.1). After each revision that moves the page's head, the Hub makes its
 * Automations what the lines say, as whoever wrote the revision: a new line
 * creates one, a changed line changes it, a line taken out deletes it, and
 * `[-]` or `[x]` stops it. The Automation rows hold what runs and how it has
 * run; what it is comes from the line. An occurrence also checks its line
 * before it runs (openOccurrenceConversation), so a sync that has not landed
 * yet never runs what the page no longer says.
 */

export interface ScheduleRow {
  id: string;
  source?: string;
  blockId?: string;
  instruction: string;
}

/** What a line is to the Automation that carries it. */
export interface ScheduleMatch<R extends ScheduleRow> {
  row?: R;
  line: PageSchedule;
}

/**
 * Pairs the page's lines with its Automations: the same line as last synced,
 * then the same instruction (its timing changed), then, within a section and
 * in order, whatever is left (its words changed). Unpaired lines are new and
 * unpaired rows are lines taken out.
 */
export function matchSchedules<R extends ScheduleRow>(rows: readonly R[], lines: readonly PageSchedule[]):
  { matches: ScheduleMatch<R>[]; removed: R[] } {
  const free = new Set(rows);
  const paired = new Map<PageSchedule, R>();
  const pass = (same: (row: R, line: PageSchedule) => boolean) => {
    for (const line of lines) {
      if (paired.has(line)) continue;
      const row = [...free].find((candidate) => same(candidate, line));
      if (!row) continue;
      free.delete(row);
      paired.set(line, row);
    }
  };
  pass((row, line) => row.source === line.source);
  pass((row, line) => row.instruction.trim() === line.instruction && row.instruction.trim() !== "");
  pass((row, line) => (row.blockId ?? "") === line.blockId);
  return { matches: lines.map((line) => ({ line, row: paired.get(line) })), removed: [...free] };
}

export interface ScheduleSyncReport {
  /** Lines that do not run as written, each with why. */
  problems: Array<{ source: string; problem: string }>;
}

function database(env: Env) {
  return createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-page-schedules", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  });
}

function rowOf(record: AutomationRecord): AutomationRecord & ScheduleRow {
  const payload = record.payload && typeof record.payload === "object" ? record.payload as Record<string, unknown> : {};
  const expression = record.expression && typeof record.expression === "object"
    ? record.expression as Record<string, unknown> : {};
  return { ...record,
    ...(typeof payload.source === "string" ? { source: payload.source } : {}),
    ...(typeof payload.blockId === "string" ? { blockId: payload.blockId } : {}),
    instruction: typeof expression.text === "string" ? expression.text : "" };
}

/** A schedule's name: its first words, so Schedules and conversations can tell it from the next. */
export function scheduleName(instruction: string): string {
  const words = instruction.replace(/\s+/gu, " ").trim();
  return words.length <= 60 ? words : `${words.slice(0, 59).trimEnd()}…`;
}

/** The line's triggers, each GitHub one bound to the installation that covers its repository. */
async function resolveTriggers(env: Env, spaceId: string, userId: string,
  triggers: AutomationTrigger[]): Promise<AutomationTrigger[] | { problem: string }> {
  const connection = async (providerId: string) => {
    const view = await findAppConnection(env, { spaceId, providerId, actorUserId: userId });
    return view?.status === "configured" ? view : undefined;
  };
  for (const provider of new Set(triggers.flatMap((trigger) => trigger.kind === "event" ? [trigger.provider] : []))) {
    if (!await connection(provider)) return { problem: `Connect ${provider} for this Space to run on its events` };
  }
  if (!triggers.some((trigger) => trigger.kind !== "event")) return triggers;
  const github = await connection("github");
  if (!github) return { problem: "Connect GitHub for this Space to run on its repositories" };
  const resolved: AutomationTrigger[] = [];
  for (const trigger of triggers) {
    if (trigger.kind === "event") {
      resolved.push(trigger);
      continue;
    }
    const [owner, repo] = trigger.repository.split("/") as [string, string];
    try {
      resolved.push({ ...trigger, installationId: await githubConnectionInstallationFor(env, github, owner, repo) });
    } catch {
      return { problem: `This Space's GitHub connection does not cover ${trigger.repository}` };
    }
  }
  return resolved;
}

/** Whether stored triggers are the line's, whatever order storage kept their keys in. */
function sameTriggers(stored: unknown, wanted: readonly AutomationTrigger[]): boolean {
  const plain = (list: readonly unknown[]) => JSON.stringify(list.map((trigger) => {
    const { installationId: _installation, ...rest } = trigger as Record<string, unknown>;
    return Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }));
  return plain(Array.isArray(stored) ? stored : []) === plain(wanted);
}

function initialDelayMs(env: Env, intervalMinutes: number): number {
  const mockDelay = env.XMATRIX_MOCK_AUTH_TOKEN ? Number(env.XMATRIX_MOCK_SCHEDULE_DELAY_MS) : Number.NaN;
  return Number.isSafeInteger(mockDelay) && mockDelay >= 250 ? mockDelay : intervalMinutes * 60_000;
}

/**
 * Makes the page's Automations what its lines say, as `userId` (the Human who
 * wrote the revision, or the Agent Run's owner). Command ids are derived from
 * the page revision and the line, so a retried sync of one revision commits
 * nothing twice; a later revision's sync converges whatever an earlier one
 * left.
 */
export async function syncPageSchedules(env: Env, input: {
  spaceId: string; pageId: string; revision: number; userId: string; viaAgentRun: boolean;
}): Promise<ScheduleSyncReport> {
  const { spaceId, pageId, userId } = input;
  const principal = { kind: "user" as const, id: userId };
  const db = database(env);
  const [{ page }, { tasks }] = await Promise.all([
    new PostgresPageRepository(db).read({ requestId: crypto.randomUUID(), spaceId, pageId, principal }),
    new PostgresAutomationRepository(db).listPage({ requestId: crypto.randomUUID(), spaceId, pageId, userId }),
  ]);
  // The head may have moved past the revision that asked; its lines are what holds now.
  const lines = pageSchedules(page.body);
  // Every page Automation has its line since migration 0235; one without is not this page's to sync.
  const rows = (tasks as AutomationRecord[]).map(rowOf).filter((row) => row.source !== undefined);
  const { matches, removed } = matchSchedules(rows, lines);
  const problems: ScheduleSyncReport["problems"] = [];
  const now = Date.now();
  // Two syncs of one head make the same new Automation, so the second's create conflicts instead of doubling
  // it; every other change is guarded by the version it read.
  const syncId = crypto.randomUUID();
  const command = (suffix: string, body: Record<string, unknown>) => commitAutomation(env, {
    commandId: `page-schedule:${syncId}:${suffix}`.slice(0, 200),
    at: new Date().toISOString(), actorUserId: userId, principal,
    // An Agent Run acts as its owner, but never with a Human admin's creation exception.
    viaAgentRun: input.viaAgentRun, ...body,
  });
  let changed = false;

  for (const row of removed) {
    await command(`remove:${row.id}`, { kind: "automation_remove", automationId: row.id, expectedVersion: row.version });
    changed = true;
  }

  for (const [index, { line, row }] of matches.entries()) {
    let problem = line.error;
    // A line that cannot be read keeps what it had, stopped, and says why.
    if (problem && !row) {
      problems.push({ source: line.source, problem });
      continue;
    }
    const once = line.intervalMinutes === undefined;
    let triggers: AutomationTrigger[] = [];
    if (!problem) {
      const resolved = await resolveTriggers(env, spaceId, userId, line.triggers);
      if ("problem" in resolved) problem = resolved.problem;
      else triggers = resolved;
    }
    const storedPayload = (row?.payload ?? {}) as Record<string, unknown>;
    const delivered = Boolean(row?.lastRunAt);
    if (!problem && once && line.status === "running" && !(row && storedPayload.at === line.at && delivered)
      && !scheduleTimeInRange(line.at!, now)) {
      problem = "⏳ is a time ahead, within a year";
    }
    if (problem) problems.push({ source: line.source, problem });
    const enabled = !problem && line.status === "running" && !(once && delivered && storedPayload.at === line.at);
    const intervalMinutes = once ? AUTOMATION_MAX_INTERVAL_MINUTES : line.intervalMinutes!;
    const definition = problem && row ? {} : {
      name: scheduleName(line.instruction), intervalMinutes,
      expression: { kind: "text", language: "natural-language", text: line.instruction },
    };
    const parsed = expressionPayload(hubBoundary, row, definition);
    if (!parsed) {
      problems.push({ source: line.source, problem: "Write what to do before 🔁 or ⏳" });
      continue;
    }
    if (!problem || !row) {
      if (once) parsed.payload.once = true; else delete parsed.payload.once;
      if (triggers.length) parsed.payload.triggers = triggers; else delete parsed.payload.triggers;
      if (line.at) parsed.payload.at = line.at; else delete parsed.payload.at;
    }
    parsed.payload.source = line.source;
    parsed.payload.blockId = line.blockId;
    if (problem) parsed.payload.problem = problem; else delete parsed.payload.problem;

    if (!row) {
      const automationId = await deterministicConversationId("page-schedule", pageId, String(page.headRevision),
        String(index));
      const channelId = await deterministicConversationId("page-schedule-timer", automationId);
      await createChannel(env, {
        commandId: `page-schedule:${automationId}:channel`.slice(0, 200),
        channelId, spaceId, name: scheduleName(line.instruction).slice(0, 80),
        mode: await effectivelyRestricted(env, spaceId, pageId, userId) ? "closed" : "open",
        metadata: { createdBy: "page-automation", fromPageId: pageId }, principal,
      });
      await command(`${index}:create`, {
        kind: "automation_put", automationId, expectedVersion: 0, channelId, pageId, enabled,
        nextRunAt: once ? line.at ?? new Date(now).toISOString()
          : line.at ?? new Date(now + initialDelayMs(env, intervalMinutes)).toISOString(),
        payload: commandPayload(hubBoundary, parsed, undefined, channelId, principal, userId, automationId),
        automationAction: "create",
      });
      changed = true;
      continue;
    }

    const binding = automationEvaluatorBinding(row);
    if (!binding) {
      problems.push({ source: line.source, problem: "This schedule has no author it can run as" });
      continue;
    }
    const redefined = !problem && (row.instruction.trim() !== line.instruction
      || (row.once === true) !== once || (!once && row.intervalMinutes !== line.intervalMinutes)
      || storedPayload.at !== line.at || !sameTriggers(storedPayload.triggers, triggers));
    const restated = redefined || row.enabled !== enabled || storedPayload.source !== line.source
      || storedPayload.blockId !== line.blockId || storedPayload.problem !== parsed.payload.problem;
    if (!restated) continue;
    const nextRunAt = once ? line.at ?? row.nextRunAt
      : line.at && line.at !== storedPayload.at ? line.at
      : redefined && row.intervalMinutes !== line.intervalMinutes || enabled && !row.enabled
        ? new Date(now + intervalMinutes * 60_000).toISOString() : row.nextRunAt;
    // An Automation runs as its author: a change to what it does, by anyone else, makes it theirs.
    if (redefined && binding.authorityRootUserId !== userId) {
      const replacementId = crypto.randomUUID();
      await command(`${index}:replace:${row.id}`, {
        kind: "automation_put", automationId: replacementId, expectedVersion: 0, channelId: row.channelId, pageId,
        enabled, nextRunAt,
        payload: commandPayload(hubBoundary, parsed, undefined, row.channelId, principal, userId, replacementId),
        automationAction: "update", replacesAutomation: { automationId: row.id, expectedVersion: row.version },
      });
    } else {
      await command(`${index}:put:${row.id}:${row.version}`, {
        kind: "automation_put", automationId: row.id, expectedVersion: row.version, channelId: row.channelId,
        enabled, nextRunAt,
        payload: commandPayload(hubBoundary, parsed, row, row.channelId, binding.actor, binding.authorityRootUserId,
          row.id),
        automationAction: redefined ? "update" : enabled ? "resume" : "pause",
      });
    }
    changed = true;
  }
  if (changed) await notifyWorkspaceResource(env, { spaceId, resource: "automations" });
  return { problems };
}

/**
 * Checks a delivered reminder's line off (`[x] … ✅ <day>`) through the page's
 * live session, as its author, so whoever is on the page sees it done; the
 * revision then syncs it as done. A line changed since is left as it is.
 */
export async function markReminderDone(env: Env, input: {
  spaceId: string; pageId: string; source: string; userId: string; day: string;
}): Promise<void> {
  const principal = { kind: "user" as const, id: input.userId, label: "xMatrix" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { page } = await new PostgresPageRepository(database(env)).read({ requestId: crypto.randomUUID(),
      spaceId: input.spaceId, pageId: input.pageId, principal: { kind: "user", id: input.userId } });
    const body = markScheduleDone(page.body, input.source, input.day);
    if (body === page.body) return;
    const response = await sessionCall(env, input.spaceId, input.pageId, "/internal/edit", {
      principal, baseRevision: page.headRevision, body, conversationIds: [] });
    if (response.ok) return;
    if (response.status !== 409) throw new Error(`page edit refused with ${response.status}`);
  }
}
