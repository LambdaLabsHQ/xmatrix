import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase } from "@xmatrix/db";
import * as db from "@xmatrix/db";
import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { scheduledTaskFailed } from "../src/scheduled-task-failure.ts";
import { sentryEventMetadata } from "../src/connectors/actions/sentry-event-metadata.ts";
import { ProviderRequestError } from "../src/connectors/http.ts";
import * as failure from "../src/connectors/apple-commerce-watch-failure.ts";
import { captureErrorReports, exceptionEvents } from "./support/error-reports.mjs";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const loadCommerce = await compileCommonJsSourceModule(new URL("../src/connectors/app-store-connect-commerce.ts", import.meta.url));

function drainer({ request, stage, finish }) {
  const job = { watchId: "watch-1", spaceId: "space-1", credentialVersion: 1, generation: "generation",
    sourceRef: "appstoreconnect:private.bundle", pending: [] };
  const calls = { finish: [], stage: 0 };
  const repository = { claim: async () => [job], current: async () => true, route: async () => null,
    stage: async (...args) => { calls.stage++; return stage(...args); },
    delivered: async () => {}, finish: async (_job, retry) => { calls.finish.push(retry); return finish(); } };
  const imports = { "@xmatrix/db": db, "./apple-commerce-watch-failure": failure, "./http": { ProviderRequestError },
    "./credentials": { appleCommerceRepository: () => repository, connectorCredentialRepository: () => ({
      resolve: async () => ({ version: 1, connectionGeneration: "generation", values: { privateKey: "private-key" } }) }) },
    "./app-store-connect-api": { appStoreConnect: () => ({ request }), appleApp: async () => ({ id: "private-app" }),
      appleResource: () => undefined },
    "./event-format": { connectorEvent: input => input, record: value => value && typeof value === "object" ? value : {},
      text: value => typeof value === "string" ? value : "" },
    "./event-ingress": { appendToRoutes: async () => {} },
    "./app-store-connect-web": { appOnly: () => ({}) },
    "../product-message-append": { dispatchProductMessageAppend: async () => new Response() },
    "../automation-triggers": { fireConnectorAutomationTriggers: async () => {} } };
  const { drainAppleCommerce } = loadCommerce(name => {
    if (!imports[name]) throw new Error(`unexpected commerce import ${name}`);
    return imports[name];
  });
  return { calls, run: () => drainAppleCommerce({}) };
}

async function reported(t, run) {
  const envelopes = captureErrorReports(t);
  t.mock.method(console, "warn", () => {});
  await assert.rejects(run, error => {
    assert.equal(error.message, "1 Apple commerce watches will retry; no snapshot or pending event was discarded");
    scheduledTaskFailed("Apple commerce recovery", error);
    return true;
  });
  await sendErrorReports();
  const events = exceptionEvents(envelopes);
  assert.equal(events.length, 1);
  const event = events[0];
  const metadata = sentryEventMetadata({ tags: [{ key: "operation", value: event.tags.operation }], context: event.extra }).join("\n");
  assert.doesNotMatch(`${JSON.stringify(event.extra)}\n${event.exception ? JSON.stringify(event.exception) : ""}\n${metadata}`, /private-/);
  return { event, metadata };
}

test("a provider rejection keeps its phase and records the retry without Apple's response (HUB-C0)", async t => {
  const drain = drainer({ request: async () => { throw new ProviderRequestError(502, "App Store Connect returned 502: private-apple-detail"); },
    stage: () => [], finish: async () => {} });
  const { event, metadata } = await reported(t, drain.run);
  assert.deepEqual(drain.calls.finish, [true]);
  assert.equal(drain.calls.stage, 0);
  const evidence = JSON.parse(event.extra.apple_commerce_watch_failure);
  assert.deepEqual(evidence, [{ phase: "snapshot", status: 502, kind: "provider", code: "unclassified", retryRecorded: true }]);
  assert.match(metadata, /Scheduled task: Apple commerce recovery/);
  assert.match(metadata, /Apple commerce watch failure: snapshot · provider · HTTP 502 · unclassified · retry recorded/);
  assert.equal(event.extra.database_failure_attempts, undefined);
});

test("a database rejection and a failed finish stay separate and keep the attempt evidence (HUB-C0)", async t => {
  const database = createAuthorityDatabase({ connectionString: "postgres://private-host", shardId: "shard-0",
    poolFactory: () => ({ async connect() { return { async query() { throw new Error("Query read timeout"); }, release() {} }; },
      async end() {} }) });
  let stageError;
  try { await database.transaction({ requestId: "private-request", operation: "app.apple-commerce.stage" }, async () => {}); }
  catch (error) { stageError = error; }
  assert.ok(stageError);
  const drain = drainer({ request: async () => ({ data: [] }), stage: () => { throw stageError; },
    finish: async () => { throw new Error("private-finish-lease"); } });
  const { event, metadata } = await reported(t, drain.run);
  assert.deepEqual(drain.calls.finish, [true]);
  assert.equal(drain.calls.stage, 1);
  assert.deepEqual(JSON.parse(event.extra.apple_commerce_watch_failure), [
    { phase: "stage", status: 0, kind: "database", code: "QUERY_READ_TIMEOUT", retryRecorded: false },
    { phase: "finish", status: 0, kind: "unclassified", code: "unclassified", retryRecorded: false },
  ]);
  const attempts = JSON.parse(event.extra.database_failure_attempts);
  assert.equal(attempts[0].operation, "app.apple-commerce.stage");
  assert.equal(attempts[0].phase, "begin");
  assert.equal(attempts[0].code, "QUERY_READ_TIMEOUT");
  assert.match(metadata, /Apple commerce watch failure: stage · database · no status · QUERY_READ_TIMEOUT · retry not recorded/);
  assert.match(metadata, /Apple commerce watch failure: finish · unclassified · no status · unclassified · retry not recorded/);
  assert.match(metadata, /Database failure 1: app.apple-commerce.stage · shard-0 · transaction · begin · database_phase_begin_v1 · QUERY_READ_TIMEOUT/);
});

test("commerce watch diagnostics drop provider text and malformed rows (HUB-C0)", () => {
  const valid = { phase: "deliver", status: 503, kind: "provider", code: "unclassified", retryRecorded: true };
  assert.deepEqual(sentryEventMetadata({ context: { apple_commerce_watch_failure: JSON.stringify([valid]) } }),
    ["Apple commerce watch failure: deliver · provider · HTTP 503 · unclassified · retry recorded"]);
  for (const invalid of [[{ ...valid, detail: "private-apple-detail" }], [{ ...valid, phase: "private-phase" }],
    [{ ...valid, code: "private-code" }], [{ ...valid, status: 999 }], [{ ...valid, retryRecorded: "true" }],
    Array(9).fill(valid), "private-apple-detail"]) {
    assert.deepEqual(sentryEventMetadata({ context: { apple_commerce_watch_failure: JSON.stringify(invalid),
      body: "private-body" } }), [], JSON.stringify(invalid));
  }
});
