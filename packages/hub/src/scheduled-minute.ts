import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { analyticsWorkerVersion } from "./analytics-sampling";
import { maintainChannelDeletions } from "./channel-deletion-maintenance";
import { noticeCliReleases, readCliReleaseFeeds } from "./cli-release-notice";
import { connectorFeishuRoomRepository, connectorGoogleChatRoomRepository, connectorTeamsRoomRepository,
  connectorTelegramRoomRepository } from "./connectors/credentials";
import { drainGmailNotifications } from "./connectors/gmail-notification-drain";
import { reconcileMailSnapshotLeases } from "./connectors/mail-snapshot-link";
import { drainSentryEvents } from "./connectors/sentry-event-drain";
import { answerHarnessReleaseWatch, watchHarnessReleasesBesidePostgres } from "./harness-release-watch";
import { maintainAccountDeletions } from "./index-routes-account-deletion";
import { maintainMachineResourceHistoryOnSchedule } from "./index-routes-machine-resources";
import { rollUpAdminActivityOnSchedule } from "./postgres-admin-activity-rollup";
import { redeliverOwedQuotaWakes } from "./quota-waits";
import { relayRuntimeSingleCell } from "./relay-authority-locator";
import { runScheduledLanes, scheduledPassesDue, type ScheduledPass } from "./scheduled-passes";
import { scheduledTaskFailed } from "./scheduled-task-failure";
import type { Env } from "./types";

export const RELAY_RUNTIME_SCHEDULED_MINUTE_PATH = "/internal/product-control/scheduled-minute";

/**
 * The minute cron's passes, in two lanes so they hold at most two PostgreSQL
 * connections: the passes that only read or write PostgreSQL, and those that
 * also wait on another service and must not hold the first lane up.
 * `inCell`: already running in the Runtime cell, so the harness release watch
 * runs here instead of being sent to the cell.
 */
export async function runMinutePasses(env: Env, scheduledTime: number, inCell: boolean): Promise<void> {
  // Feeds first: a pass below holds a Hyperdrive connection, and six
  // header-waits is the invocation's whole budget (HUB-BX).
  const latest = await readCliReleaseFeeds();
  const database: ScheduledPass[] = [
    { name: "Account deletion maintenance", work: () => maintainAccountDeletions(env) },
    { name: "Channel deletion maintenance", work: () => maintainChannelDeletions(env) },
    { name: "Machine load history maintenance", work: () => maintainMachineResourceHistoryOnSchedule(env, scheduledTime) },
    { name: "Admin activity rollup", work: () => rollUpAdminActivityOnSchedule(env, scheduledTime) },
    // Delivers again quota waits a reading already made ready; never asks a provider.
    { name: "Quota wait redelivery", work: () => redeliverOwedQuotaWakes(env) },
    // Rows these delete have already expired for every reader, so nothing
    // waits on them: each runs once an hour, in its own minute.
    ...([["Teams", connectorTeamsRoomRepository, 7], ["Google Chat", connectorGoogleChatRoomRepository, 22], ["Feishu", connectorFeishuRoomRepository, 37], ["Telegram", connectorTelegramRoomRepository, 52]] as const)
      .map(([provider, repository, hourlyAtMinute]) => ({ name: `${provider} lifecycle maintenance`, hourlyAtMinute,
        work: () => repository(env).cleanup({ requestId: crypto.randomUUID(), limit: 100 }) })),
  ];
  const network: ScheduledPass[] = [
    { name: "Sentry event recovery", work: () => drainSentryEvents(env) },
    { name: "Gmail notification recovery and renewal", work: () => drainGmailNotifications(env) },
    { name: "Gmail snapshot cleanup", work: () => reconcileMailSnapshotLeases(env) },
    // In the cell this is the cell's own answer: an outage is deferred, a defect thrown.
    { name: "Harness release watch", work: () => inCell
      ? answerHarnessReleaseWatch(env).then(response => response.body?.cancel())
      : watchHarnessReleasesBesidePostgres(env) },
    { name: "CLI release notice", work: () => noticeCliReleases(env, { latest }) },
  ];
  // A pass that fails after its lane stopped waiting still sends its report.
  await runScheduledLanes([scheduledPassesDue(database, scheduledTime), network], (name, error) => {
    scheduledTaskFailed(name, error);
    void sendErrorReports();
  });
  await sendErrorReports();
}

/**
 * The cron's side: the minute's passes run in the Runtime cell, which is
 * created next to PostgreSQL. Placement moves only fetch handlers, so the cron
 * itself runs wherever Cloudflare starts it; from there each database round
 * trip took about 170 ms against about 20 ms beside the database, and a
 * transaction's connection was held that much longer for every round trip.
 *
 * Nothing depends on the cell for correctness. A cell still on an earlier
 * release has no such route (a deploy reaches this Worker first): its 404
 * names that release and the cron runs the passes itself. Any other failure
 * is reported and left to the next minute, since the cell may have run them.
 */
export async function runMinutePassesBesidePostgres(env: Env, scheduledTime: number,
  local: typeof runMinutePasses = runMinutePasses): Promise<"cell" | "cron"> {
  const response = await relayRuntimeSingleCell(env).fetch(new Request(
    `https://relay-runtime${RELAY_RUNTIME_SCHEDULED_MINUTE_PATH}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ scheduledTime }) }));
  if (response.status === 204) return "cell";
  const body = await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (response.status === 404 && typeof body.workerVersion === "string" && body.workerVersion !== analyticsWorkerVersion(env)) {
    await local(env, scheduledTime, false);
    return "cron";
  }
  throw new Error(`Scheduled minute answered ${response.status}: ${String(body.error ?? "no error")}`);
}

/** The Runtime cell's side: the minute's passes, each reporting its own failure. */
export async function answerScheduledMinute(env: Env, request: Request,
  run: typeof runMinutePasses = runMinutePasses): Promise<Response> {
  const body = await request.json<{ scheduledTime?: unknown }>().catch(() => null);
  const scheduledTime = body?.scheduledTime;
  if (typeof scheduledTime !== "number" || !Number.isSafeInteger(scheduledTime)) {
    return Response.json({ error: "Invalid scheduled minute" }, { status: 400 });
  }
  await run(env, scheduledTime, true);
  return new Response(null, { status: 204 });
}
