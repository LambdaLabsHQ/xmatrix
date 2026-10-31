import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { registerCliUpdateCheckRoutes } from "../src/index-routes-cli-update-check.ts";

const AT = "2026-10-31T14:00:00.000Z";

function route(user, decision, { asked = true } = {}) {
  const calls = [], app = new Hono();
  registerCliUpdateCheckRoutes(app, { authenticate: async () => user,
    decide: async (_env, input) => { calls.push({ name: "decide", input }); return decision; },
    ask: async (_env, input) => { calls.push({ name: "ask", input }); return asked; },
    fail: async (_env, input) => { calls.push({ name: "fail", input });
      return { state: "failed", error: input.error, at: input.requestedAt }; } });
  return { calls, post: body => app.request("/api/machine-daemons/cli-update-check",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, {}) };
}

const checking = { outcome: "checking", coalesced: false, daemonVersion: "2.3.1", cliUpdate: { state: "checking", at: AT },
  route: { daemonId: "daemon:a", hostId: "host-a" } };

test("the owner's view asks the Machine's daemon to check, once, and is told it is checking", async () => {
  const owner = route({ id: "owner" }, checking);
  const response = await owner.post({ machineId: "machine:a" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { outcome: "checking", coalesced: false, daemonVersion: "2.3.1",
    cliUpdate: { state: "checking", at: AT } });
  const decide = owner.calls.find(call => call.name === "decide").input;
  assert.deepEqual([decide.ownerUserId, decide.machineId], ["owner", "machine:a"]);
  assert.match(decide.requestId, /^cli-update:[0-9a-f-]{36}$/u);
  const ask = owner.calls.find(call => call.name === "ask").input;
  assert.deepEqual(ask, { ownerUserId: "owner", machineId: "machine:a", hostId: "host-a", requestId: decide.requestId });
});

test("a request within the minute joins the last check and sends nothing", async () => {
  const joined = { outcome: "checking", coalesced: true, cliUpdate: { state: "installing", version: "2.3.2", at: AT } };
  const owner = route({ id: "owner" }, joined);
  assert.deepEqual(await (await owner.post({ machineId: "machine:a" })).json(), joined);
  assert.deepEqual(owner.calls.map(call => call.name), ["decide"]);
});

test("a daemon that cannot check says exactly why, and nothing is sent", async () => {
  for (const decision of [{ outcome: "offline" }, { outcome: "unsupported", daemonVersion: "2.2.0" },
    { outcome: "self_update_disabled", daemonVersion: "2.3.1" }]) {
    const owner = route({ id: "owner" }, decision);
    assert.deepEqual(await (await owner.post({ machineId: "machine:a" })).json(), decision);
    assert.deepEqual(owner.calls.map(call => call.name), ["decide"]);
  }
  assert.equal((await route({ id: "owner" }, { outcome: "conflict" }).post({ machineId: "machine:a" })).status, 409);
});

test("a check the daemon's connection never took is failed at once, not left checking", async () => {
  const owner = route({ id: "owner" }, checking, { asked: false });
  const body = await (await owner.post({ machineId: "machine:a" })).json();
  assert.equal(body.outcome, "offline");
  assert.equal(body.cliUpdate.state, "failed");
  assert.match(body.cliUpdate.error, /not connected/u);
  const fail = owner.calls.find(call => call.name === "fail").input;
  assert.deepEqual([fail.daemonId, fail.requestedAt], ["daemon:a", AT]);
});

test("Agent Runs and bad input are refused before anything is decided", async () => {
  const agent = route({ id: "agent-run:run", agentRun: { runId: "run", ownerUserId: "owner" } }, checking);
  assert.equal((await agent.post({ machineId: "machine:a" })).status, 403);
  assert.deepEqual(agent.calls, []);
  const owner = route({ id: "owner" }, checking);
  assert.equal((await owner.post({ machineId: "" })).status, 400);
  assert.equal((await owner.post({})).status, 400);
  assert.deepEqual(owner.calls, []);
});
