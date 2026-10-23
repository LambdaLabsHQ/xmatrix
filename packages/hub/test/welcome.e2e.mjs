import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareTestAgentRun } from "./e2e-utils.mjs";
import { personalSpace, withOwnerWorker } from "./owner-worker.mjs";
import { connectDaemon, createWorkspace } from "./agent-launch-postgres.fixture.mjs";
import { inWorkerTransaction, registerTestAgent } from "./registration-launch.fixture.mjs";

const personal = personalSpace;
const welcome = (call, spaceId, options = {}) =>
  call(`/api/spaces/${encodeURIComponent(spaceId)}/welcome`, { method: "POST", ...options });
async function steps(call, channelId) {
  const { status, body } = await call(`/api/channels/${encodeURIComponent(channelId)}/history?limit=20`);
  assert.equal(status, 200, JSON.stringify(body));
  return body.messages.map((message) => ({ stage: message.metadata?.stage, kind: message.metadata?.kind,
    from: message.from?.label, body: message.body }));
}

async function withWelcomeAgent(worker, token, spaceId, check) {
  const machineId = `machine:welcome-${randomUUID()}`;
  const hostId = machineId.replace(/^machine:/u, "");
  const daemon = await connectDaemon(worker, { machineId, hostId }, token);
  try {
    await registerTestAgent(worker, { token, spaceId, machineId, displayName: "codex" });
    await check();
  } finally {
    await daemon.close?.();
  }
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

test("a Chinese browser's welcome is written in Chinese", () =>
  withOwnerWorker("Lin Huiyin", async ({ call }) => {
    const space = await personal(call);
    const { channelId } = (await welcome(call, space.id, { body: { locale: "zh-CN" } })).body;
    const page = await call(`/api/channels/page?spaceId=${encodeURIComponent(space.id)}&view=flat&filter=all`);
    const row = page.body.rows.find((candidate) => (candidate.channel?.id ?? candidate.id) === channelId);
    assert.equal((row?.channel ?? row)?.name, "欢迎来到 xMatrix", JSON.stringify(row));
    const [written] = await steps(call, channelId);
    assert.equal(written.stage, "bring-agents");
    assert.match(written.body, /^把你的 Agent 带进 xMatrix。/u);
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
    const first = await welcome(call, space.id);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // A new harness changes the welcome's generated body, but the first
    // published step must remain the one historical fact on reload.
    await registerTestAgent(worker, { token, spaceId: space.id, machineId, harness: "claude",
      displayName: "claude", canonicalCwd });
    const reloads = await Promise.all([welcome(call, space.id), welcome(call, space.id)]);
    for (const reload of reloads) assert.equal(reload.status, 200, JSON.stringify(reload.body));
    const written = await steps(call, channelId);
    assert.deepEqual(written.map((step) => step.stage), ["bring-agents", "agents-in"]);
    assert.match(written[1].body, /@codex is in\. Mention it here to give it work\./u);
  }));

test("welcome steps outlive their replay records and are not recreated after recall", () =>
  withOwnerWorker("Katherine Johnson", async ({ worker, call }) => {
    const space = await personal(call);
    const { channelId } = (await welcome(call, space.id)).body;
    const messageId = `system:welcome:${channelId}:bring-agents`;
    // Reproduce the retention worker's expiry without waiting for the TTL.
    await inWorkerTransaction(worker, tx => tx.query({
      text: "DELETE FROM data.idempotency_keys WHERE space_id=$1 AND idempotency_key=$2",
      values: [space.id, `product:welcome:${channelId}:bring-agents`],
    }));
    const replay = await welcome(call, space.id);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal((await steps(call, channelId)).length, 1);
    const recall = await call(`/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
    });
    assert.equal(recall.status, 200, JSON.stringify(recall.body));
    const afterRecall = await welcome(call, space.id);
    assert.equal(afterRecall.status, 200, JSON.stringify(afterRecall.body));
    assert.equal((await steps(call, channelId)).filter(step => step.body.includes("Bring your agents")).length, 0);
  }));

test("a conflicting welcome command without a committed step remains an error", () =>
  withOwnerWorker("Dorothy Vaughan", async ({ worker, token, call }) => {
    const space = await personal(call);
    const { channelId } = (await welcome(call, space.id)).body;
    await withWelcomeAgent(worker, token, space.id, async () => {
      await inWorkerTransaction(worker, tx => tx.query({
        text: `INSERT INTO data.idempotency_keys
          (space_id,idempotency_key,command_kind,request_digest,result_json,created_at,expires_at)
          VALUES ($1,$2,'message-append',$3,'{}',now(),now()+interval '1 day')`,
        values: [space.id, `product:welcome:${channelId}:agents-in`, "0".repeat(64)],
      }));
      assert.equal((await welcome(call, space.id)).status, 500);
      assert.deepEqual((await steps(call, channelId)).map(step => step.stage), ["bring-agents"]);
    });
  }));

test("concurrent welcome calls converge on the same two steps", () =>
  withOwnerWorker("Margaret Hamilton", async ({ worker, token, call }) => {
    const space = await personal(call);
    await withWelcomeAgent(worker, token, space.id, async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => welcome(call, space.id)));
      for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(results[0].body.channelId, results[1].body.channelId);
      assert.deepEqual((await steps(call, results[0].body.channelId)).map(step => step.stage),
        ["bring-agents", "agents-in"]);
    });
  }));

// A reserve for a command holds its Channel's sequence row while it checks for
// the command's reservation; the append committing that reservation must take
// the sequence row first, or the two wait on each other (40P01).
test("a step's append and a concurrent reserve of it take the sequence row in one order", () =>
  withOwnerWorker("Grace Hopper", async ({ worker, token, call }) => {
    const space = await personal(call);
    const { channelId } = (await welcome(call, space.id)).body;
    const commandId = `product:welcome:${channelId}:agents-in`;
    const sequenceRow = "WHERE space_id=$1 AND channel_id=$2";
    await inWorkerTransaction(worker, async tx => {
      const [{ allocated_sequence: sequence }] = await tx.query({
        text: `UPDATE data.channel_message_sequences SET allocated_sequence=allocated_sequence+1
          ${sequenceRow} RETURNING allocated_sequence`, values: [space.id, channelId] });
      await tx.query({
        text: `INSERT INTO data.message_sequence_reservations
          (space_id,command_id,channel_id,sequence,state,created_at,updated_at,expires_at)
          VALUES ($1,$2,$3,$4,'reserved',now(),now(),now()+interval '1 day')`,
        values: [space.id, commandId, channelId, sequence] });
    });
    await withWelcomeAgent(worker, token, space.id, async () => {
      const { append: appended } = await inWorkerTransaction(worker, async reserve => {
        const [{ xid }] = await reserve.query({ text: `UPDATE data.channel_message_sequences
          SET updated_at=updated_at ${sequenceRow} RETURNING pg_current_xact_id()::text AS xid`,
          values: [space.id, channelId] });
        const append = welcome(call, space.id);
        // The append's lock timeout is short: act as soon as it waits on this transaction.
        for (let waited = 0; ; waited += 20) {
          const [{ waiting }] = await inWorkerTransaction(worker, tx => tx.query({
            text: `SELECT count(*)::int AS waiting FROM pg_locks
              WHERE NOT granted AND locktype='transactionid' AND transactionid::text=$1`, values: [xid] }));
          if (waiting > 0) break;
          assert.ok(waited < 20_000, "the append never waited on the Channel's sequence row");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        // The reserve's own check for the command, while the append waits on it.
        await reserve.query({
          text: `INSERT INTO data.message_sequence_reservations
            (space_id,command_id,channel_id,sequence,state,created_at,updated_at,expires_at)
            VALUES ($1,$2,$3,1000000,'reserved',now(),now(),now()+interval '1 day')
            ON CONFLICT (space_id,command_id) DO NOTHING`,
          values: [space.id, commandId, channelId] });
        // Committed before the append is awaited: it waits on this transaction.
        return { append };
      });
      const appendedResult = await appended;
      assert.equal(appendedResult.status, 200, JSON.stringify(appendedResult.body));
      assert.deepEqual((await steps(call, channelId)).map(step => step.stage), ["bring-agents", "agents-in"]);
    });
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
