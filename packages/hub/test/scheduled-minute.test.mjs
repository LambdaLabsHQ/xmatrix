import assert from "node:assert/strict";
import { test } from "node:test";

import { answerScheduledMinute, RELAY_RUNTIME_SCHEDULED_MINUTE_PATH, runMinutePassesBesidePostgres } from "../src/scheduled-minute.ts";

/** An env whose Runtime cell answers with `answer`, recording what it was asked. */
function cellEnv(answer) {
  const asked = [];
  return { asked, env: {
    CF_VERSION_METADATA: { id: "this-release" }, XMATRIX_RUNTIME_LOCATION_HINT: "apac",
    RELAY_RUNTIME: { idFromName: name => name, get: (id, options) => ({ fetch: async request => {
      asked.push({ id, options, url: request.url, method: request.method, body: await request.json() });
      return answer();
    } }) },
  } };
}

test("the cron hands the minute to the Runtime cell beside PostgreSQL and runs nothing itself", async () => {
  const { env, asked } = cellEnv(() => new Response(null, { status: 204 }));
  const local = [];
  assert.equal(await runMinutePassesBesidePostgres(env, 1_800_000_000_000, async (...args) => { local.push(args); }), "cell");
  assert.deepEqual(asked, [{ id: "cell-0@apac", options: { locationHint: "apac" },
    url: `https://relay-runtime${RELAY_RUNTIME_SCHEDULED_MINUTE_PATH}`, method: "POST", body: { scheduledTime: 1_800_000_000_000 } }]);
  assert.equal(local.length, 0);
});

test("a cell still on an earlier release has no route, so the cron runs the minute itself", async () => {
  const { env } = cellEnv(() => Response.json({ error: "Not found", workerVersion: "earlier-release" }, { status: 404 }));
  const local = [];
  assert.equal(await runMinutePassesBesidePostgres(env, 42, async (_env, scheduledTime, inCell) => { local.push([scheduledTime, inCell]); }), "cron");
  assert.deepEqual(local, [[42, false]]);
});

test("any other answer is a failure and never a second run: the cell may have run the passes", async () => {
  for (const answer of [
    () => Response.json({ error: "boom" }, { status: 500 }),
    () => Response.json({ error: "Not found", workerVersion: "this-release" }, { status: 404 }),
  ]) {
    const { env } = cellEnv(answer);
    const local = [];
    await assert.rejects(runMinutePassesBesidePostgres(env, 42, async () => { local.push(1); }), /Scheduled minute answered (500|404)/);
    assert.equal(local.length, 0);
  }
});

test("the cell runs the minute it was given, as the cell, and refuses anything else", async () => {
  const runs = [];
  const run = async (_env, scheduledTime, inCell) => { runs.push([scheduledTime, inCell]); };
  const request = body => new Request("https://relay-runtime/x", { method: "POST", body });
  assert.equal((await answerScheduledMinute({}, request(JSON.stringify({ scheduledTime: 1_800_000_000_000 })), run)).status, 204);
  assert.deepEqual(runs, [[1_800_000_000_000, true]]);
  for (const body of ["", "{}", JSON.stringify({ scheduledTime: "now" }), JSON.stringify({ scheduledTime: 1.5 })]) {
    assert.equal((await answerScheduledMinute({}, request(body), run)).status, 400);
  }
  assert.equal(runs.length, 1);
});
