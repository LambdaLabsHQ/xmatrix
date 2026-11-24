import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { registerLogExcerptRoutes } from "../src/index-routes-log-excerpts.ts";

const daemon = { id: "daemon:a", email: "owner@example.test", machineId: "machine:a", hostId: "host-a", status: "online" };
const controlId = "logs:00000000-0000-4000-8000-000000000000";

function route(user, { daemons = [daemon] } = {}) {
  const calls = [], app = new Hono();
  registerLogExcerptRoutes(app, { authenticate: async () => user,
    daemons: async () => daemons,
    issue: async (_env, input) => { calls.push({ name: "issue", input }); return { ok: true }; },
    status: async (_env, ownerUserId, id) => { calls.push({ name: "status", input: { ownerUserId, controlId: id } });
      return ownerUserId === "owner" ? { controlId: id, status: "succeeded", excerpt: "== daemon.err ==\nok" }
        : { status: "missing" }; } });
  return { calls,
    post: body => app.request("/api/machine-daemons/log-excerpts",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, {}),
    get: id => app.request(`/api/machine-daemons/log-excerpts/${encodeURIComponent(id)}`, {}, {}) };
}

test("the owner asks the one online daemon of their Machine for its log excerpt", async () => {
  const owner = route({ id: "owner" });
  const response = await owner.post({ machineId: "machine:a" });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.match(body.controlId, /^logs:[0-9a-f-]{36}$/u);
  const issued = owner.calls.find(call => call.name === "issue").input;
  assert.deepEqual(issued.payload, { type: "machine_log_excerpt", requestId: body.controlId });
  assert.deepEqual([issued.ownerUserId, issued.daemonId, issued.commandType, issued.principal.id],
    ["owner", "daemon:a", "log_excerpt", "owner"]);
  assert.equal((await (await owner.get(controlId)).json()).excerpt, "== daemon.err ==\nok");
});

test("only the signed-in owner, as a Human, asks for or reads a Machine's logs", async () => {
  const agent = route({ id: "agent-run:run", agentRun: { ownerUserId: "owner", runId: "run" } });
  assert.equal((await agent.post({ machineId: "machine:a" })).status, 403);
  assert.equal((await agent.get(controlId)).status, 403);
  assert.deepEqual(agent.calls, [], "an Agent Run reaches neither the daemon nor the stored excerpt");
  const owner = route({ id: "owner" });
  const invalid = [{}, { machineId: "" }, { machineId: "machine:a", path: "/etc/passwd" }];
  for (const body of invalid) assert.equal((await owner.post(body)).status, 400);
  const offline = route({ id: "owner" }, { daemons: [{ ...daemon, status: "offline" }] });
  assert.equal((await offline.post({ machineId: "machine:a" })).status, 409);
  assert.deepEqual([...owner.calls, ...offline.calls].filter(call => call.name === "issue"), []);
  assert.equal((await owner.get("worktree:00000000-0000-4000-8000-000000000000")).status, 404);
  const other = route({ id: "someone-else" });
  assert.equal((await other.get(controlId)).status, 404, "another person's excerpt reads as missing");
  assert.deepEqual(other.calls.map(call => call.input.ownerUserId), ["someone-else"]);
});
