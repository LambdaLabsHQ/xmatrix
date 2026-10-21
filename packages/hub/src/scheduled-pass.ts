import { reportError, sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { analyticsWorkerVersion } from "./analytics-sampling";
import { maintainChannelDeletions } from "./channel-deletion-maintenance";
import {
  connectorFeishuRoomRepository, connectorGoogleChatRoomRepository, connectorTeamsRoomRepository,
  connectorTelegramRoomRepository,
} from "./connectors/credentials";
import { drainGmailNotifications } from "./connectors/gmail-notification-drain";
import { drainSentryEvents } from "./connectors/sentry-event-drain";
import { watchHarnessReleases } from "./harness-release-watch";
import { maintainAccountDeletions } from "./index-routes-account-deletion";
import { maintainMachineResourceHistoryOnSchedule } from "./index-routes-machine-resources";
import { retryablePostgresFailure } from "./postgres-error-classification";
import { relayRuntimeSingleCell } from "./relay-authority-locator";
import type { Env } from "./types";

/** The Runtime cell route that runs one cron pass beside PostgreSQL. */
export const RELAY_RUNTIME_SCHEDULED_PASS_PATH = "/internal/product-control/scheduled-pass";

const NO_STORE = { "cache-control": "no-store" } as const;

/** One cron task. Each runs every minute, so it already tolerates a pass that overlaps the last. */
export type ScheduledTask = readonly [name: string, work: () => Promise<unknown>];

export function scheduledTasks(env: Env, scheduledTime: number): ScheduledTask[] {
  return [
    ["Account deletion maintenance", () => maintainAccountDeletions(env)],
    ["Channel deletion maintenance", () => maintainChannelDeletions(env)],
    ["Sentry event recovery", () => drainSentryEvents(env)],
    ["Gmail notification recovery and renewal", () => drainGmailNotifications(env)],
    ["Harness release watch", () => watchHarnessReleases(env)],
    ["Machine load history maintenance", () => maintainMachineResourceHistoryOnSchedule(env, scheduledTime)],
    ...([["Teams", connectorTeamsRoomRepository], ["Google Chat", connectorGoogleChatRoomRepository],
      ["Feishu", connectorFeishuRoomRepository], ["Telegram", connectorTelegramRoomRepository]] as const)
      .map(([provider, repository]): ScheduledTask => [`${provider} lifecycle maintenance`,
        () => repository(env).cleanup({ requestId: crypto.randomUUID(), limit: 100 })]),
  ];
}

/**
 * Placement moves only fetch handlers, so Cloudflare starts the cron far from
 * PostgreSQL (MIA or ATL in production): 175-490 ms per round trip, against
 * milliseconds for the Worker's placed requests. Each transaction the pass
 * opened there held its origin connection across those round trips, so about
 * 3.5% of the Hub's sessions took a third of its origin connection time, all
 * opened at the top of the minute, and their BEGINs could take seconds
 * (XMATRIX-HUB-90). The release watch held a Machine's lock for seconds the
 * same way (XMATRIX-HUB-7K). The whole pass therefore runs in the Runtime
 * cell, which is created next to the database; the cron only asks it to.
 */
export async function runScheduledPassBesidePostgres(
  env: Pick<Env, "RELAY_RUNTIME" | "XMATRIX_RUNTIME_LOCATION_HINT" | "CF_VERSION_METADATA">,
  scheduledTime: number,
): Promise<void> {
  const response = await relayRuntimeSingleCell(env).fetch(new Request(
    `https://relay-runtime${RELAY_RUNTIME_SCHEDULED_PASS_PATH}`,
    { method: "POST", body: JSON.stringify({ scheduledTime }) }));
  if (response.ok) return;
  const body = await response.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  // A deploy reaches this Worker before the cell restarts on it, and a cell
  // still on an earlier release has no such route (XMATRIX-HUB-7M). Its 404
  // names that release, so only a rollout in progress waits for the next pass;
  // a missing route on this same release is still a defect.
  if (response.status === 404 && typeof body.workerVersion === "string" &&
      body.workerVersion !== analyticsWorkerVersion(env)) {
    console.warn("Scheduled pass reached a Runtime cell on another release", {
      cellVersion: body.workerVersion, workerVersion: analyticsWorkerVersion(env) });
    return;
  }
  throw new Error(`Scheduled pass answered ${response.status}: ${String(body.error ?? "no error")}`);
}

/** The Runtime cell's side: every task runs, and each failure is logged where it happened. */
export async function answerScheduledPass(
  request: Request,
  env: Env,
  tasks: (env: Env, scheduledTime: number) => ScheduledTask[] = scheduledTasks,
): Promise<Response> {
  const { scheduledTime } = await request.json<{ scheduledTime?: unknown }>();
  if (typeof scheduledTime !== "number" || !Number.isSafeInteger(scheduledTime)) {
    return Response.json({ error: "Invalid scheduled time" }, { status: 400, headers: NO_STORE });
  }
  const pass = tasks(env, scheduledTime);
  try {
    await Promise.all(pass.map(([name, work]) =>
      Promise.resolve().then(work).catch((error: unknown) => scheduledTaskFailed(name, error))));
  } finally {
    await sendErrorReports();
  }
  return Response.json({ tasks: pass.length }, { headers: NO_STORE });
}

/** A failed cron task names its cause; a database outage is logged, a defect is also reported. */
export function scheduledTaskFailed(name: string, error: unknown): void {
  console.error(`${name} failed`, error);
  if (!retryablePostgresFailure(error)) reportError(error, { operation: `scheduled: ${name}` });
}
