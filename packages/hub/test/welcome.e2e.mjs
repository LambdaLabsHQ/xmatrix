import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareTestAgentRun } from "./e2e-utils.mjs";
import { personalSpace, withOwnerWorker } from "./owner-worker.mjs";
import { connectDaemon, createWorkspace } from "./agent-launch-postgres.fixture.mjs";
import { registerTestAgent } from "./registration-launch.fixture.mjs";

const personal = personalSpace;
const welcome = (call, spaceId, options = {}) =>
  call(`/api/spaces/${encodeURIComponent(spaceId)}/welcome`, { method: "POST", ...options });
async function steps(call, channelId) {
  const { status, body } = await call(`/api/channels/${encodeURIComponent(channelId)}/history?limit=20`);
  assert.equal(status, 200, JSON.stringify(body));
  return body.messages.map((message) => ({ stage: message.metadata?.stage, kind: message.metadata?.kind,
    from: message.from?.label, body: message.body }));
}

test("a personal Space opens with xMatrix's welcome, written once", () =>
  withOwnerWorker("Ada Lovelace", async ({ call }) => {
    const space = await personal(call);
    const first = await welcome(call, space.id);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const { channelId } = first.body;
    assert.equal(typeof channelId, "string");
    const page = await call(`/api/channels/page?spaceId=${encodeURIComponent(space.id)}&view=flat&filter=all`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const row = page.body.rows.find((candidate) => (candidate.channel?.id ?? candidate.id) === channelId);
    const conversation = row?.channel ?? row;
    assert.equal(conversation?.name, "Welcome to xMatrix", JSON.stringify(row));
    assert.equal(conversation?.mode, "closed");

    // A reload or a second tab replays the same step instead of adding one.
    assert.equal((await welcome(call, space.id)).body.channelId, channelId);
    const written = await steps(call, channelId);
    assert.equal(written.length, 1);
    assert.equal(written[0].kind, "xmatrix.onboarding.v1");
    assert.equal(written[0].stage, "bring-agents");
    assert.equal(written[0].from, "xMatrix");
  }));

test("once an agent is in, xMatrix says so in the welcome, once", () =>
  withOwnerWorker("Grace Hopper", async ({ worker, token, call }) => {
    const space = await personal(call);
    const { channelId } = (await welcome(call, space.id)).body;
    const machineId = `machine:welcome-${randomUUID()}`;
    const canonicalCwd = `/tmp/xmatrix-welcome-${randomUUID()}`;
    const hostId = machineId.replace(/^machine:/u, "");
    const daemon = await connectDaemon(worker, { machineId, hostId }, token);
    try {
      await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: "welcome" }, token);
      await registerTestAgent(worker, { token, spaceId: space.id, machineId, displayName: "codex", canonicalCwd });
    } finally {
      await daemon.close?.();
    }
    await welcome(call, space.id);
    await welcome(call, space.id);
    const written = await steps(call, channelId);
    assert.deepEqual(written.map((step) => step.stage), ["bring-agents", "agents-in"]);
    assert.match(written[1].body, /@codex is in\. Mention it here to give it work\./u);
  }));

test("only a person's own personal Space gets a welcome", () =>
  withOwnerWorker("Alan Turing", async ({ worker, token, call }) => {
    const space = await personal(call);
    const team = await call("/api/spaces", { method: "POST", body: { name: "Team" } });
    assert.equal(team.status, 200, JSON.stringify(team.body));
    const other = await welcome(call, team.body.space.id);
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(other.body.channelId, null);

    const run = await prepareTestAgentRun(worker, {
      name: `welcome-agent-${randomUUID()}`, agentType: "codex", spaceId: space.id,
    }, token);
    assert.equal((await welcome(call, space.id, { bearer: run.token })).status, 401);
  }));
