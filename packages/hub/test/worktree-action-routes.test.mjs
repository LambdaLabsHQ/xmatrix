import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { registerWorktreeActionRoutes } from "../src/index-routes-worktree-actions.ts";

const daemon = { id: "daemon:a", email: "owner@example.test", machineId: "machine:a", hostId: "host-a", status: "online" };

function route(user, { daemons = [daemon] } = {}) {
  const calls = [], app = new Hono();
  registerWorktreeActionRoutes(app, { authenticate: async () => user,
    daemons: async () => daemons,
    issue: async (_env, input) => { calls.push({ name: "issue", input }); return { ok: true }; },
    status: async (_env, ownerUserId, controlId) => { calls.push({ name: "status", input: { ownerUserId, controlId } });
      return { controlId, action: "list", status: "running" }; },
    latest: async (_env, ownerUserId, machineId) => { calls.push({ name: "latest", input: { ownerUserId, machineId } });
      return undefined; } });
  return { calls,
    post: body => app.request("/api/machine-daemons/worktree-actions",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, {}),
    get: id => app.request(`/api/machine-daemons/worktree-actions/${encodeURIComponent(id)}`, {}, {}),
    list: query => app.request(`/api/machine-daemons/worktree-actions${query}`, {}, {}) };
}

test("the owner issues a worktree action to the one online daemon of the Machine", async () => {
  const owner = route({ id: "owner" });
  const response = await owner.post({ machineId: "machine:a", action: "reclaim", paths: ["/tmp/a"], command: "rm -rf /" });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.match(body.controlId, /^worktree:[0-9a-f-]{36}$/u);
  const issued = owner.calls.find(call => call.name === "issue").input;
  assert.deepEqual(issued.payload, { type: "machine_worktree_action", requestId: body.controlId, action: "reclaim",
    paths: ["/tmp/a"] });
  assert.deepEqual([issued.ownerUserId, issued.daemonId, issued.commandType], ["owner", "daemon:a", "worktree_action"]);
  assert.deepEqual(issued.principal, { kind: "user", id: "owner" });
});

test("Agent runs, bad input and offline Machines are refused before anything is issued", async () => {
  const agent = route({ id: "agent-run:run", agentRun: { runId: "run", ownerUserId: "owner" } });
  assert.equal((await agent.post({ machineId: "machine:a", action: "list" })).status, 403);
  assert.equal((await agent.get("worktree:00000000-0000-4000-8000-000000000000")).status, 403);
  assert.equal((await agent.list("?machineId=machine:a")).status, 403);
  assert.deepEqual(agent.calls, []);
  const statusOf = async (caller, body) => (await caller.post(body)).status;
  const owner = route({ id: "owner" });
  const invalid = [{ machineId: "machine:a", action: "purge" }, { action: "list" },
    { machineId: "machine:a", action: "reclaim" }, { machineId: "machine:a", action: "list", paths: ["/tmp"] }];
  assert.deepEqual(await Promise.all(invalid.map(body => statusOf(owner, body))), [400, 400, 400, 400]);
  const offline = route({ id: "owner" }, { daemons: [{ ...daemon, status: "offline" }] });
  assert.equal(await statusOf(offline, { machineId: "machine:a", action: "list" }), 409);
  assert.deepEqual([...owner.calls, ...offline.calls].filter(call => call.name === "issue"), []);
  assert.equal((await owner.get("harness:00000000-0000-4000-8000-000000000000")).status, 404);
});

test("status and the latest listing are read for the signed-in owner", async () => {
  const owner = route({ id: "owner" });
  const id = "worktree:00000000-0000-4000-8000-000000000000";
  assert.equal((await (await owner.get(id)).json()).status, "running");
  assert.deepEqual((await (await owner.list("?machineId=machine:a")).json()), { listing: null });
  assert.deepEqual(owner.calls.map(call => call.input.ownerUserId), ["owner", "owner"]);
});
