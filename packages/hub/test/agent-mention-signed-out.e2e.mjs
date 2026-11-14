import { assert, json, MOCK_TOKEN, postChannelMessage, randomUUID, sleep, test } from "./agent-mention-spawn.fixture.mjs";
import {
  channelSpaceId, connectDaemon, createClosedChannel, createWorkspace, inTestTransaction, registerTestAgent,
  startPgHubWorker, testMachine, testPostgresUrl,
} from "./agent-launch-postgres.fixture.mjs";
import { createAuthorityDatabase, PostgresRuntimeRepository } from "@xmatrix/db";

/** The machine's harness report, as its daemon stores it. */
const reporting = (capturedAt, login) => JSON.stringify({ schemaVersion: 1, capturedAt,
  items: [{ id: "codex", installed: true, probeStatus: "ok", version: "0.159.0", login }] });

test("a summon reaches its machine whatever was last said about its program's sign-in", async () => {
  const userId = `signed-out-e2e-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "signed-out-e2e@example.com", XMATRIX_MOCK_AUTH_NAME: "Signed Out E2E" } });
  let daemon;
  try {
    const { hostId, machineId } = testMachine("workstation");
    const channelId = (await createClosedChannel(worker, `signed-out-${randomUUID()}`)).id;
    daemon = await connectDaemon(worker, { machineId, hostId });
    const canonicalCwd = `/tmp/xmatrix-signed-out-${randomUUID()}`;
    await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: "signed-out-workspace" });
    const spaceId = await channelSpaceId(channelId);
    await registerTestAgent(worker, { token: MOCK_TOKEN, spaceId, machineId, displayName: "codex-signed-out", canonicalCwd });
    const summoned = async (body) => {
      const messageId = (await postChannelMessage(worker, MOCK_TOKEN, channelId, body)).message.messageId;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const value = await json(await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/agent-launches/query`, {
          method: "POST", headers: { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ sourceMessageIds: [messageId], pageSize: 20 }) }));
        if (value?.rejections?.length || value?.launches?.length) return { ...value, messageId };
        await sleep(50);
      }
      throw new Error("the summon settled neither way");
    };
    const launched = async (body) => {
      const value = await summoned(body);
      assert.deepEqual((value.rejections ?? []).map(item => item.code), []);
      assert.equal(value.launches.length, 1);
      return { messageId: value.messageId, runId: value.launches[0].runId };
    };
    const mention = `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}" fix the build`;

    // The machine's last report said its Codex was signed out. Only the program
    // knows whether that is still so, and it is asked by being given the work.
    await inTestTransaction(tx => tx.query({ text: `UPDATE data.machine_daemons
      SET metadata_json=jsonb_set(metadata_json,'{harnesses}',$2::jsonb) WHERE machine_id=$1`,
    values: [machineId, reporting(new Date().toISOString(), "signed_out")] }));
    const first = await launched(mention);

    // When that Run's program refuses its first turn as signed out, its notice
    // names the program and machine and carries the summon to send again; once
    // the Run has replied, a later refusal answers no summon. Nothing is written.
    const runtime = new PostgresRuntimeRepository(createAuthorityDatabase({ connectionString: testPostgresUrl(), shardId: "shard-0" }));
    const refused = () => runtime.signedOutRunHarness({ requestId: randomUUID(), runId: first.runId, actorUserId: userId });
    // The Run's route is published just after its launch commits.
    let unanswered;
    for (let attempt = 0; attempt < 100 && !(unanswered = await refused()); attempt += 1) await sleep(50);
    assert.equal(unanswered.signedOut.harness, "codex");
    assert.equal(unanswered.signedOut.program, "Codex");
    assert.equal(unanswered.signedOut.machineId, machineId);
    assert.equal(unanswered.summon.sourceMessageId, first.messageId);
    assert.ok(mention.startsWith(unanswered.summon.sourceMention), unanswered.summon.sourceMention);
    await inTestTransaction(tx => tx.query({ text: `UPDATE data.agent_launches SET first_reply_at=now() WHERE run_id=$1`,
      values: [first.runId] }));
    assert.equal(unanswered.unanswered, true);
    assert.deepEqual(await refused(), { signedOut: unanswered.signedOut, unanswered: false });
    const marked = await inTestTransaction(tx => tx.query({ text: `SELECT metadata_json ? 'signedOutAt' AS marked
      FROM data.runs WHERE run_id=$1`, values: [first.runId] }));
    assert.equal(marked[0].marked, false);

    // A Run of the same Agent whose program refused as signed out a moment ago
    // says nothing about now either: the next summon is given to it again.
    const runId = `${channelId}:9#1`;
    await inTestTransaction(async tx => {
      await tx.query({ text: `INSERT INTO data.runs (run_id,owner_user_id,channel_id,workspace_machine_id,workspace_canonical_cwd,
          status,version,metadata_json,created_at,updated_at,finished_at)
        VALUES ($1,$2,$3,$4,$5,'exited',1,jsonb_build_object('signedOutAt',now(),'invocationProgress',
          jsonb_build_object('operationFailure',jsonb_build_object('code','harness_signed_out'))),now(),now(),now())`,
      values: [runId, userId, channelId, machineId, canonicalCwd] });
      await tx.query({ text: `INSERT INTO data.run_agent_registrations (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,
          allocation_id,authorization_digest,grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
        VALUES ($1,$2,$3,$4,'codex',$3,$5,$6,1,1,1,1,'{}'::jsonb)`,
      values: [runId, spaceId, userId, machineId, `allocation:${randomUUID()}`, "0".repeat(64)] });
    });
    await launched(`${mention} again`);
  } finally {
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});
