#!/usr/bin/env node
// Origin connection time by operation, from the Hub's session telemetry and
// Hyperdrive's pool analytics. Capacity is connections divided by how long each
// piece of work holds one, so this is the table to read before adding either.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     node scripts/postgres-connection-report.mjs [--hours 24] [--config <hyperdrive id>]
//
// Exits 1 when a budget below is exceeded, so a scheduled run can alert.
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Budgets a scheduled run fails on. Raise one only with the measurement that justifies it. */
export const CONNECTION_BUDGETS = {
  /** Share of minutes in which any request waited for an origin connection. */
  waitingMinuteShare: 0.05,
  /** Share of connection time spent by work no user asked for (the cron's passes). */
  backgroundShare: 0.25,
  /** Sessions opened inside another session's open transaction. */
  nestedSessions: 0,
  /** Average round trips of one session of an operation; each holds the connection. */
  roundTripsPerSession: 12,
};

const DATASET = "xmatrix_relay_authority_observability";
/** Operations only the minute cron runs. */
const BACKGROUND = "blob11 LIKE 'app.%.cleanup' OR blob11 LIKE 'app.gmail-routing.%' OR blob11 LIKE 'app.sentry-event.%' " +
  "OR blob11 LIKE 'app.apple-commerce.%' OR blob11 IN ('account-deletion.pending','registration.quota.owed'," +
  "'channel-purge.pending','machine-control.harness-release-targets','machine-control.cli-release-owners')";

export function connectionReportQueries(hours) {
  const since = `timestamp > NOW() - INTERVAL '${hours}' HOUR`;
  const session = `FROM ${DATASET} WHERE blob1='session' AND ${since}`;
  return {
    operations: `SELECT blob11 AS operation, sum(double4) AS sessions, sum(double1*double4)/1000 AS seconds,
      sum(double13*double4)/sum(double4) AS round_trips, sum(if(double1>=1000,double4,0.0)) AS over_1s
      ${session} GROUP BY operation ORDER BY seconds DESC LIMIT 25 FORMAT JSON`,
    classes: `SELECT if(${BACKGROUND},'background','request') AS class, sum(double4) AS sessions,
      sum(double1*double4)/1000 AS seconds ${session} GROUP BY class FORMAT JSON`,
    nested: `SELECT blob12 AS outer_operation, blob11 AS inner_operation, count() AS sessions
      ${session} AND blob12 != 'none' AND blob12 != '' GROUP BY outer_operation, inner_operation
      ORDER BY sessions DESC LIMIT 25 FORMAT JSON`,
  };
}

/** What the measurements say against the budgets; `failures` is empty when all hold. */
export function assessConnectionReport({ operations, classes, nested, waiting }, budgets = CONNECTION_BUDGETS) {
  const seconds = Object.fromEntries(classes.map(row => [row.class, Number(row.seconds)]));
  const total = (seconds.background ?? 0) + (seconds.request ?? 0);
  const backgroundShare = total > 0 ? (seconds.background ?? 0) / total : 0;
  const waitingMinuteShare = waiting.minutes > 0 ? waiting.waitingMinutes / waiting.minutes : 0;
  const nestedSessions = nested.reduce((sum, row) => sum + Number(row.sessions), 0);
  const heavy = operations.filter(row => Number(row.round_trips) > budgets.roundTripsPerSession)
    .map(row => `${row.operation} (${Number(row.round_trips).toFixed(1)})`);
  const failures = [];
  if (waitingMinuteShare > budgets.waitingMinuteShare) {
    failures.push(`requests waited for a connection in ${(waitingMinuteShare * 100).toFixed(1)}% of minutes (budget ${budgets.waitingMinuteShare * 100}%)`);
  }
  if (backgroundShare > budgets.backgroundShare) {
    failures.push(`background work used ${(backgroundShare * 100).toFixed(1)}% of connection time (budget ${budgets.backgroundShare * 100}%)`);
  }
  if (nestedSessions > budgets.nestedSessions) {
    failures.push(`${nestedSessions} sessions were opened inside another session's transaction`);
  }
  if (heavy.length) failures.push(`over ${budgets.roundTripsPerSession} round trips per session: ${heavy.join(", ")}`);
  return { total, backgroundShare, waitingMinuteShare, nestedSessions, failures };
}

async function analyticsSql(account, token, sql, fetchImpl) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
    { method: "POST", headers: { authorization: `Bearer ${token}` }, body: sql });
  if (!response.ok) throw new Error(`Analytics Engine answered ${response.status}`);
  return (await response.json()).data ?? [];
}

async function poolWaiting(account, token, config, hours, fetchImpl) {
  const until = new Date(), since = new Date(until.getTime() - hours * 3_600_000);
  const filter = `{${config ? `configId:"${config}",` : ""}datetime_geq:"${since.toISOString()}",datetime_lt:"${until.toISOString()}"}`;
  const query = `{viewer{accounts(filter:{accountTag:"${account}"}){hyperdrivePoolSizesAdaptiveGroups(limit:10000,filter:${filter}){max{waitingClients currentPoolSize} dimensions{datetimeMinute configId poolShardId}}}}}`;
  const response = await fetchImpl("https://api.cloudflare.com/client/v4/graphql",
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Error(`Hyperdrive analytics failed (${response.status})`);
  return summarizePoolWaiting(payload.data.viewer.accounts[0]?.hyperdrivePoolSizesAdaptiveGroups ?? []);
}

/** Minutes observed, minutes with any client waiting, and the largest single pool. */
export function summarizePoolWaiting(rows) {
  const minutes = new Map();
  let largestPool = 0;
  for (const row of rows) {
    const minute = row.dimensions.datetimeMinute;
    minutes.set(minute, (minutes.get(minute) ?? 0) + Number(row.max.waitingClients ?? 0));
    largestPool = Math.max(largestPool, Number(row.max.currentPoolSize ?? 0));
  }
  return { minutes: minutes.size, waitingMinutes: [...minutes.values()].filter(waiting => waiting > 0).length, largestPool };
}

export async function connectionReport({ account, token, hours = 24, config }, fetchImpl = fetch) {
  const queries = connectionReportQueries(hours);
  const [operations, classes, nested, waiting] = await Promise.all([
    analyticsSql(account, token, queries.operations, fetchImpl), analyticsSql(account, token, queries.classes, fetchImpl),
    analyticsSql(account, token, queries.nested, fetchImpl), poolWaiting(account, token, config, hours, fetchImpl),
  ]);
  return { hours, operations, classes, nested, waiting, ...assessConnectionReport({ operations, classes, nested, waiting }) };
}

export function formatConnectionReport(report) {
  const lines = [
    `Origin connection time, last ${report.hours} h: ${report.total.toFixed(0)} s`,
    `Background share: ${(report.backgroundShare * 100).toFixed(1)}%`,
    `Minutes with a request waiting: ${report.waiting.waitingMinutes} of ${report.waiting.minutes} (${(report.waitingMinuteShare * 100).toFixed(1)}%)`,
    `Largest pool: ${report.waiting.largestPool} connection(s)`,
    "", "operation | sessions | seconds | round trips | over 1 s", "--- | --- | --- | --- | ---",
    ...report.operations.map(row => `${row.operation} | ${Number(row.sessions).toFixed(0)} | ${Number(row.seconds).toFixed(0)} | ${Number(row.round_trips).toFixed(1)} | ${Number(row.over_1s).toFixed(0)}`),
  ];
  if (report.nested.length) {
    lines.push("", "Sessions opened inside another transaction (outer <- inner):",
      ...report.nested.map(row => `- ${row.outer_operation} <- ${row.inner_operation}: ${row.sessions}`));
  }
  lines.push("", report.failures.length ? `OVER BUDGET:\n${report.failures.map(failure => `- ${failure}`).join("\n")}` : "Within budget.");
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) { console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required"); process.exit(2); }
  const hours = Number(flag("--hours") ?? 24);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) { console.error("--hours must be 1-720"); process.exit(2); }
  const report = await connectionReport({ account, token, hours, config: flag("--config") });
  console.log(formatConnectionReport(report));
  process.exit(report.failures.length ? 1 : 0);
}
