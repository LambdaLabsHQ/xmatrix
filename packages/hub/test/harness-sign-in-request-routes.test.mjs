import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { harnessSignedOutNoticeOf } from "@xmatrix/protocol";
import { registerHarnessSignInRequestRoutes } from "../src/index-routes-harness-sign-in-requests.ts";

const run = { ownerUserId: "owner", agentName: "claude", runId: "run", channelId: "channel", machineId: "machine:a" };
const inventory = (items) => ({ harnesses: { schemaVersion: 1, capturedAt: "2026-10-31T20:00:00.000Z", items } });
const daemon = { id: "daemon:a", userId: "owner", email: "owner@example.test", machineId: "machine:a", machineName: "srv",
  status: "online", metadata: inventory([{ id: "antigravity", installed: true, probeStatus: "ok", version: "1.4.12", login: "signed_out" }]) };

function route(user, daemons = [daemon]) {
  const appended = [], app = new Hono();
  registerHarnessSignInRequestRoutes(app, { authenticate: async () => user, daemons: async () => daemons,
    append: async (_env, channelId, append) => { appended.push({ channelId, append }); return {}; } });
  return { appended,
    post: (body) => app.request("/api/harness-sign-in-requests",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, {}) };
}

test("an Agent Run posts the signed-out card for its own Machine in its own Channel", async () => {
  const agent = route({ id: "agent-run:run", email: "owner@example.test", agentRun: run });
  const response = await agent.post({ harness: "agy", reason: "Daily report runs on Antigravity", requestId: "r1" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { messageId: agent.appended[0].append.messageId, harness: "antigravity",
    program: "Google Antigravity", machineId: "machine:a", machineName: "srv", login: "signed_out", signInHere: true });
  const [{ channelId, append }] = agent.appended;
  assert.equal(channelId, "channel");
  assert.match(append.messageId, /^harness-sign-in-request:[a-f0-9]{64}$/u);
  assert.equal(append.messageKind, "xmatrix.system.harness-sign-in-request");
  assert.deepEqual(append.waitsOnUserIds, ["owner"], "it waits on the Machine's owner");
  assert.equal(append.body, "**claude** asks to sign in Google Antigravity on srv: Daily report runs on Antigravity\n\n" +
    "The machine's owner signs it in on this card.");
  // The Web reads it as the signed-out notice, which signs the program in where it is.
  assert.deepEqual(harnessSignedOutNoticeOf(append.residual.appMetadata), { requestedBy: "claude",
    signedOut: { harness: "antigravity", program: "Google Antigravity", machineId: "machine:a", machineName: "srv" } });

  // A retry replays the same card; another request is a new one.
  await agent.post({ harness: "agy", reason: "Daily report runs on Antigravity", requestId: "r1" });
  await agent.post({ harness: "agy", reason: "Daily report runs on Antigravity", requestId: "r2" });
  const ids = agent.appended.map((item) => item.append.messageId);
  assert.equal(ids[1], ids[0]);
  assert.notEqual(ids[2], ids[0]);
});

test("any harness can be asked for, on any of the owner's Machines, with or without a remote sign-in", async () => {
  const other = { ...daemon, id: "daemon:b", machineId: "machine:b", machineName: "laptop", status: "offline",
    metadata: inventory([{ id: "pi", installed: true, probeStatus: "ok", version: "0.9.0" }]) };
  const agent = route({ id: "agent-run:run", email: "owner@example.test", agentRun: run }, [daemon, other]);
  const response = await agent.post({ harness: "pi", machineId: "machine:b" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.signInHere, false, "pi signs in on its machine; the card says how");
  assert.equal(body.machineName, "laptop");
  assert.match(agent.appended[0].append.body, /^\*\*claude\*\* asks to sign in Pi on laptop\.\n/u);
});

test("people, unknown harnesses, other owners' Machines and missing installs are refused before a card", async () => {
  const person = route({ id: "owner", email: "owner@example.test" });
  assert.equal((await person.post({ harness: "codex" })).status, 403);
  const agent = route({ id: "agent-run:run", email: "owner@example.test", agentRun: run });
  for (const body of [{}, { harness: "" }, { harness: "codex", reason: 7 }, { harness: "codex", machineId: 3 },
    { harness: "codex", requestId: "../x" }]) {
    assert.equal((await agent.post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await agent.post({ harness: "custom" })).status, 400);
  assert.equal((await agent.post({ harness: "no-such-harness" })).status, 400);
  assert.equal((await agent.post({ harness: "codex", machineId: "machine:elsewhere" })).status, 404);
  const missing = route({ id: "agent-run:run", email: "owner@example.test", agentRun: run },
    [{ ...daemon, metadata: inventory([{ id: "antigravity", installed: false, probeStatus: "missing" }]) }]);
  const refused = await missing.post({ harness: "antigravity" });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /not installed on srv\. Install it there first: xmatrix harness install antigravity/u);
  assert.deepEqual([...person.appended, ...agent.appended, ...missing.appended], []);
});
