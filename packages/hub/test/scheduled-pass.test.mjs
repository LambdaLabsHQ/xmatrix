import assert from "node:assert/strict";
import test from "node:test";
import {
  answerScheduledPass,
  RELAY_RUNTIME_SCHEDULED_PASS_PATH,
  runScheduledPassBesidePostgres,
  scheduledTasks,
} from "../src/scheduled-pass.ts";

/** A Runtime namespace that records which cell, at which location, received each request. */
function runtimeNamespace(answer) {
  const calls = [];
  return {
    calls,
    idFromName: (name) => ({ name }),
    get: (id, options) => ({
      fetch: async (request) => {
        calls.push({ name: id.name, locationHint: options?.locationHint, method: request.method,
          path: new URL(request.url).pathname, body: await request.json() });
        return answer(request);
      },
    }),
  };
}

function quietConsole(t) {
  const logged = { warn: [], error: [] };
  t.mock.method(console, "warn", (...args) => logged.warn.push(args));
  t.mock.method(console, "error", (...args) => logged.error.push(args));
  return logged;
}

const pass = (scheduledTime) => new Request(`https://relay-runtime${RELAY_RUNTIME_SCHEDULED_PASS_PATH}`,
  { method: "POST", body: JSON.stringify({ scheduledTime }) });

test("the cron runs its whole pass in the Runtime cell beside PostgreSQL, not where it starts (XMATRIX-HUB-90)", async () => {
  const runtime = runtimeNamespace(() => Response.json({ tasks: 10 }));
  await runScheduledPassBesidePostgres({ RELAY_RUNTIME: runtime, XMATRIX_RUNTIME_LOCATION_HINT: "apac" }, 1_760_932_800_000);
  assert.deepEqual(runtime.calls, [{ name: "cell-0@apac", locationHint: "apac", method: "POST",
    path: RELAY_RUNTIME_SCHEDULED_PASS_PATH, body: { scheduledTime: 1_760_932_800_000 } }]);
});

test("every cron task is in the pass the cell runs", () => {
  assert.deepEqual(scheduledTasks({}, 0).map(([name]) => name), [
    "Account deletion maintenance",
    "Channel deletion maintenance",
    "Sentry event recovery",
    "Gmail notification recovery and renewal",
    "Harness release watch",
    "Machine load history maintenance",
    "Teams lifecycle maintenance",
    "Google Chat lifecycle maintenance",
    "Feishu lifecycle maintenance",
    "Telegram lifecycle maintenance",
  ]);
});

test("the cell runs every task with the cron's time; a failed task neither stops the others nor fails the pass", async (t) => {
  const logged = quietConsole(t);
  const ran = [];
  const response = await answerScheduledPass(pass(1_760_932_800_000), {}, (_env, scheduledTime) => [
    ["Outage", async () => { ran.push(["Outage", scheduledTime]); throw new Error("Query read timeout"); }],
    ["Defect", () => { ran.push(["Defect", scheduledTime]); throw new TypeError("defect"); }],
    ["Healthy", async () => { ran.push(["Healthy", scheduledTime]); }],
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tasks: 3 });
  assert.deepEqual(ran.map(([name]) => name).sort(), ["Defect", "Healthy", "Outage"]);
  assert.ok(ran.every(([, scheduledTime]) => scheduledTime === 1_760_932_800_000));
  assert.deepEqual(logged.error.map(([line]) => line).sort(), ["Defect failed", "Outage failed"]);
});

test("the cell refuses a pass without a scheduled time", async () => {
  const response = await answerScheduledPass(pass("now"), {}, () => { throw new Error("must not run"); });
  assert.equal(response.status, 400);
});

test("a cell still on the previous release is waited out; a missing route on this release fails the pass", async (t) => {
  const logged = quietConsole(t);
  const deployed = { CF_VERSION_METADATA: { id: "new-version" } };
  const previous = runtimeNamespace(() => Response.json({ error: "Not found", workerVersion: "old-version" },
    { status: 404 }));
  await runScheduledPassBesidePostgres({ ...deployed, RELAY_RUNTIME: previous }, 0);
  assert.equal(logged.warn.length, 1);

  const same = runtimeNamespace(() => Response.json({ error: "Not found", workerVersion: "new-version" },
    { status: 404 }));
  await assert.rejects(runScheduledPassBesidePostgres({ ...deployed, RELAY_RUNTIME: same }, 0),
    /answered 404: Not found/u);
});

test("the Runtime cell's 404 names the release it runs", async () => {
  const { RelayRuntimeLive } = await import("../src/relay-runtime.ts");
  const runtime = Object.create(RelayRuntimeLive.prototype);
  Object.assign(runtime, { env: { CF_VERSION_METADATA: { id: "cell-version" } }, ctx: { waitUntil() {} } });
  const response = await runtime.fetch(new Request("https://relay-runtime/internal/no-such-route", { method: "POST" }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found", workerVersion: "cell-version" });
});

test("the Runtime cell runs the pass on its own bindings and answers once every task settles", async (t) => {
  const logged = quietConsole(t);
  const { RelayRuntimeLive } = await import("../src/relay-runtime.ts");
  const runtime = Object.create(RelayRuntimeLive.prototype);
  Object.assign(runtime, { env: {}, ctx: { waitUntil() {} } });
  const response = await runtime.fetch(pass(0));
  assert.equal(response.status, 200);
  // Without bindings, the tasks that need the database or storage fail in the cell, each on its own.
  const failed = logged.error.map(([line]) => line);
  assert.ok(failed.includes("Harness release watch failed"), failed.join(", "));
  assert.ok(failed.includes("Channel deletion maintenance failed"), failed.join(", "));
});
