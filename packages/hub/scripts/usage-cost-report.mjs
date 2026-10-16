#!/usr/bin/env node
/*
 * Operator-paid usage per Space from the `xmatrix_usage_cost` Analytics Engine
 * dataset (docs/operations/usage-cost-metering.md). Read-only: one SQL query
 * through the Cloudflare Analytics Engine SQL API.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
 *     node packages/hub/scripts/usage-cost-report.mjs [--since 24h | --from <ISO> --to <ISO>]
 *       [--space <id>] [--jev-input-usd-per-mtok 0.042] [--jev-output-usd-per-mtok 0]
 *       [--dataset xmatrix_usage_cost] [--account <id>] [--json]
 *
 * The token needs Account Analytics: Read. It is sent only to api.cloudflare.com
 * and never printed.
 */
import process from "node:process";

const LAYOUT = "usage_cost_v1";
/** Third-party-reported Jev list price; unverified against an invoice. */
const DEFAULT_JEV_INPUT_USD_PER_MTOK = 0.042;
const DEFAULT_JEV_OUTPUT_USD_PER_MTOK = 0;
const ID = /^[A-Za-z0-9_.:@-]{1,96}$/u;

function fail(message) {
  console.error(`usage-cost-report: ${message}`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { since: "24h", dataset: "xmatrix_usage_cost", json: false,
    inputPrice: DEFAULT_JEV_INPUT_USD_PER_MTOK, outputPrice: DEFAULT_JEV_OUTPUT_USD_PER_MTOK,
    account: process.env.CLOUDFLARE_ACCOUNT_ID?.trim() };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => argv[++index] ?? fail(`${flag} needs a value`);
    if (flag === "--since") options.since = value();
    else if (flag === "--from") options.from = value();
    else if (flag === "--to") options.to = value();
    else if (flag === "--space") options.space = value();
    else if (flag === "--dataset") options.dataset = value();
    else if (flag === "--account") options.account = value();
    else if (flag === "--jev-input-usd-per-mtok") options.inputPrice = Number(value());
    else if (flag === "--jev-output-usd-per-mtok") options.outputPrice = Number(value());
    else if (flag === "--json") options.json = true;
    else if (flag === "--help" || flag === "-h") {
      console.log("node packages/hub/scripts/usage-cost-report.mjs [--since 24h|7d | --from <ISO> --to <ISO>] " +
        "[--space <id>] [--jev-input-usd-per-mtok 0.042] [--jev-output-usd-per-mtok 0] [--dataset <name>] [--json]");
      process.exit(0);
    } else fail(`unknown argument ${flag}`);
  }
  if (!/^[0-9a-f]{32}$/u.test(options.account ?? "")) fail("set CLOUDFLARE_ACCOUNT_ID or --account to a 32-hex account id");
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(options.dataset)) fail("--dataset is not a dataset name");
  if (options.space !== undefined && !ID.test(options.space)) fail("--space is not a Space or user id");
  for (const price of [options.inputPrice, options.outputPrice]) {
    if (!Number.isFinite(price) || price < 0) fail("prices are non-negative USD per million tokens");
  }
  return { ...options, ...queryWindow(options) };
}

/** The query window as whole seconds in UTC. */
function queryWindow(options) {
  const now = Date.now();
  let from, to;
  if (options.from !== undefined || options.to !== undefined) {
    from = Date.parse(options.from ?? "");
    to = options.to === undefined ? now : Date.parse(options.to);
  } else {
    const match = /^(\d{1,4})([hd])$/u.exec(options.since);
    if (!match) fail("--since is a number of hours or days, like 1h or 7d");
    to = now;
    from = now - Number(match[1]) * (match[2] === "h" ? 3_600_000 : 86_400_000);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) fail("the window needs --from before --to (ISO 8601)");
  return { from: new Date(Math.floor(from / 1000) * 1000), to: new Date(Math.floor(to / 1000) * 1000) };
}

const sqlTime = date => date.toISOString().slice(0, 19).replace("T", " ");

function query(options) {
  return `SELECT index1 AS scope, blob3 AS scope_kind, blob2 AS source, blob4 AS feature, blob7 AS outcome,
  SUM(_sample_interval * double1) AS calls,
  SUM(_sample_interval * double2) AS input_tokens,
  SUM(_sample_interval * double3) AS output_tokens
FROM ${options.dataset}
WHERE blob1 = '${LAYOUT}'
  AND timestamp >= toDateTime('${sqlTime(options.from)}') AND timestamp < toDateTime('${sqlTime(options.to)}')
  ${options.space ? `AND index1 = '${options.space}'` : ""}
GROUP BY scope, scope_kind, source, feature, outcome
ORDER BY calls DESC
LIMIT 10000
FORMAT JSON`;
}

async function rows(options) {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) fail("set CLOUDFLARE_API_TOKEN (Account Analytics: Read)");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${options.account}/analytics_engine/sql`,
    { method: "POST", headers: { authorization: `Bearer ${token}` }, body: query(options) });
  const text = await response.text();
  if (!response.ok) fail(`Analytics Engine SQL answered ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text).data ?? [];
}

const number = value => Number(value) || 0;

/** Per-Space totals: Jev by feature with its estimated cost, and connector calls by source. */
function summarize(data, options) {
  const spaces = new Map();
  const cost = (input, output) => (input * options.inputPrice + output * options.outputPrice) / 1_000_000;
  for (const row of data) {
    const key = `${row.scope_kind}:${row.scope}`;
    const space = spaces.get(key) ?? { scopeKind: row.scope_kind, scope: row.scope, jev: {}, connectors: {},
      jevCalls: 0, jevInputTokens: 0, jevOutputTokens: 0, jevEstimatedUsd: 0 };
    spaces.set(key, space);
    const calls = number(row.calls), errors = row.outcome === "ok" ? 0 : calls;
    if (row.source === "jev") {
      const input = number(row.input_tokens), output = number(row.output_tokens);
      const feature = space.jev[row.feature] ??= { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
      Object.assign(feature, { calls: feature.calls + calls, errors: feature.errors + errors,
        inputTokens: feature.inputTokens + input, outputTokens: feature.outputTokens + output,
        estimatedUsd: feature.estimatedUsd + cost(input, output) });
      space.jevCalls += calls;
      space.jevInputTokens += input;
      space.jevOutputTokens += output;
      space.jevEstimatedUsd += cost(input, output);
    } else {
      const connector = space.connectors[`${row.source}/${row.feature}`] ??= { calls: 0, errors: 0 };
      connector.calls += calls;
      connector.errors += errors;
    }
  }
  return [...spaces.values()].sort((left, right) => right.jevEstimatedUsd - left.jevEstimatedUsd ||
    right.jevCalls - left.jevCalls);
}

function print(spaces, options) {
  const usd = value => `$${value.toFixed(6)}`;
  console.log(`Usage cost ${options.from.toISOString()} to ${options.to.toISOString()} ` +
    `(${options.dataset}, layout ${LAYOUT})`);
  console.log(`Jev estimate: $${options.inputPrice}/1M input tokens, $${options.outputPrice}/1M output tokens ` +
    "(third-party-reported price, unverified against an invoice)");
  if (!spaces.length) {
    console.log("No datapoints in this window.");
    return;
  }
  const features = new Map();
  for (const space of spaces) {
    for (const [name, feature] of Object.entries(space.jev)) {
      const total = features.get(name) ?? { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
      for (const field of Object.keys(total)) total[field] += feature[field];
      features.set(name, total);
    }
  }
  console.log("\nJev by feature, all Spaces");
  for (const [name, total] of [...features].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(`  ${name.padEnd(16)} calls ${String(total.calls).padStart(7)}  errors ${String(total.errors).padStart(5)}  ` +
      `in ${String(total.inputTokens).padStart(10)}  out ${String(total.outputTokens).padStart(8)}  ${usd(total.estimatedUsd)}`);
  }
  console.log(`\nPer Space (${spaces.length})`);
  for (const space of spaces) {
    const connectors = Object.entries(space.connectors)
      .map(([name, { calls, errors }]) => `${name} ${calls}${errors ? ` (${errors} failed)` : ""}`).join(", ");
    console.log(`${space.scopeKind} ${space.scope}: Jev ${space.jevCalls} calls, in ${space.jevInputTokens} / ` +
      `out ${space.jevOutputTokens} tokens, ${usd(space.jevEstimatedUsd)}${connectors ? `; ${connectors}` : ""}`);
    for (const [name, feature] of Object.entries(space.jev).sort((a, b) => b[1].calls - a[1].calls)) {
      console.log(`    jev ${name}: ${feature.calls} calls${feature.errors ? ` (${feature.errors} failed)` : ""}, ` +
        `in ${feature.inputTokens} / out ${feature.outputTokens}, ${usd(feature.estimatedUsd)}`);
    }
  }
}

const options = parseArguments(process.argv.slice(2));
const spaces = summarize(await rows(options), options);
if (options.json) {
  console.log(JSON.stringify({ from: options.from.toISOString(), to: options.to.toISOString(), dataset: options.dataset,
    layout: LAYOUT, jevPriceUsdPerMillionTokens: { input: options.inputPrice, output: options.outputPrice,
      source: "third-party-reported, unverified" }, spaces }, null, 2));
} else print(spaces, options);
