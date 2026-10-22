import { assert, json, MOCK_TOKEN, postChannelMessage, randomUUID, sleep, test } from "./agent-mention-spawn.fixture.mjs";
import {
  channelSpaceId, connectDaemon, createClosedChannel, createWorkspace, inTestTransaction, registerTestAgent,
  startPgHubWorker, testMachine,
} from "./agent-launch-postgres.fixture.mjs";

/** The machine's harness report, as its daemon stores it. */
const reporting = (capturedAt, login) => JSON.stringify({ schemaVersion: 1, capturedAt,
  items: [{ id: "codex", installed: true, probeStatus: "ok", version: "0.130.0", login }] });

test("a summon only a signed-out agent could take is refused naming it, from its report or a refused turn its Instances have not spoken since", async () => {
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
    const refusal = async (body) => {
      const messageId = (await postChannelMessage(worker, MOCK_TOKEN, channelId, body)).message.messageId;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const value = await json(await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/agent-launches/query`, {
          method: "POST", headers: { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ sourceMessageIds: [messageId], pageSize: 20 }) }));
        if (value?.rejections?.length || value?.launches?.length) return value;
        await sleep(50);
      }
      throw new Error("the summon settled neither way");
    };
    const mention = `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}" fix the build`;
    const report = (capturedAt, login) => inTestTransaction(tx => tx.query({ text: `UPDATE data.machine_daemons
      SET metadata_json=jsonb_set(metadata_json,'{harnesses}',$2::jsonb) WHERE machine_id=$1`,
    values: [machineId, reporting(capturedAt, login)] }));

    // The machine says its Codex is signed out: nothing is launched, and the refusal names it.
    await report(new Date().toISOString(), "signed_out");
    const reported = await refusal(mention);
    assert.deepEqual(reported.launches, []);
    assert.equal(reported.rejections[0].code, "registration_harness_signed_out");
    assert.equal(reported.rejections[0].signedOut.harness, "codex");
    assert.equal(reported.rejections[0].signedOut.machineId, machineId);

    // It says signed in, but a turn it refused since says otherwise (an expired
    // token its status command does not see): still refused.
    await report(new Date(Date.now() - 60_000).toISOString(), "signed_in");
    const runId = `${channelId}:9#1`;
    await inTestTransaction(async tx => {
      await tx.query({ text: `INSERT INTO data.runs (run_id,owner_user_id,channel_id,workspace_machine_id,workspace_canonical_cwd,
          status,version,metadata_json,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,'running',1,jsonb_build_object('signedOutAt',now()),now(),now())`,
      values: [runId, userId, channelId, machineId, canonicalCwd] });
      await tx.query({ text: `INSERT INTO data.run_agent_registrations (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,
          allocation_id,authorization_digest,grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
        VALUES ($1,$2,$3,$4,'codex',$3,$5,$6,1,1,1,1,'{}'::jsonb)`,
      values: [runId, spaceId, userId, machineId, `allocation:${randomUUID()}`, "0".repeat(64)] });
    });
    assert.equal((await refusal(`${mention} again`)).rejections[0]?.code, "registration_harness_signed_out");

    // The Instance's message in its name after it: Hub's turn-failure notice
    // is not it speaking (still refused); its own reply is (another process of
    // the program refreshed the sign-in), so the summon is routed again.
    const instanceId = `${channelId}:9`;
    const speak = (messageId, sequence) => inTestTransaction(tx => tx.query({ text: `INSERT INTO data.messages
      SELECT (jsonb_populate_record(NULL::data.messages, to_jsonb(source) || jsonb_build_object(
        'message_id',$2::text,'author_kind','agent','author_id',$3::text,'timeline_sequence',$4::bigint,
        'search_rank_sequence',$2::text,'source_family_sequence',NULL,
        'created_at',now()+interval '1 second','updated_at',now()+interval '1 second','sent_at',now()+interval '1 second'))).*
      FROM data.messages source WHERE channel_id=$1 AND author_kind='user' LIMIT 1`,
    values: [channelId, messageId, instanceId, sequence] }));
    await inTestTransaction(tx => tx.query({ text: `INSERT INTO data.instances
      (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES ($1,$2,$3,9,'busy',1,now(),now())`, values: [instanceId, runId, channelId] }));
    await speak(`turn-failure:${instanceId}:${channelId}:${randomUUID()}`, 90_001);
    assert.equal((await refusal(`${mention} still`)).rejections[0]?.code, "registration_harness_signed_out");
    await speak(randomUUID(), 90_002);
    const routed = await refusal(`${mention} once more`);
    assert.deepEqual((routed.rejections ?? []).map(item => item.code), []);
    assert.equal(routed.launches.length, 1);
  } finally {
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});
