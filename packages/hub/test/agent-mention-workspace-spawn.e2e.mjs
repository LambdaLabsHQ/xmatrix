import { stopAgentWorker } from "./support/agent-worker.mjs";
import { startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";
import {
  assert,
  connectAgent,
  connectSpawnedMockAgent,
  json,
  mintAgentRunToken,
  MOCK_TOKEN,
  randomUUID,
  runAgentConnection,
  test,
  waitForChannelHistoryMessage,
} from "./agent-mention-spawn.fixture.mjs";
import { Client } from "pg";
import { createAuthorityDatabase, PostgresContentRepository } from "../../db/dist/index.js";
import {
  acceptSpaceInvite, channelSpaceId, connectDaemon, createClosedChannel, createSpace, createWorkspace, inviteToSpace,
  isSpawnOf, postAutoLaunch, registerTestAgent, startPgHubWorker, testMachine,
  homeSpaceId,
  testPostgresUrl,
} from "./agent-launch-postgres.fixture.mjs";

test("bare @agent:new is rejected with a system notice and does not spawn", async () => {
  const userId = `agent-summon-bare-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "agent-summon-bare@example.com", name: "Agent Summon Bare E2E" });
  let daemon;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("agent-summon-bare");
    const channelId = (await createClosedChannel(worker, `agent-summon-bare-${randomUUID()}`)).id;
    daemon = await connectDaemon(worker, { machineId, hostId });
    const registration = await registerTestAgent(worker, { token: MOCK_TOKEN,
      spaceId: await channelSpaceId(channelId), machineId, displayName: "codex-bare-route" });

    let sawSpawn = false;
    const spawnWatch = daemon.inbox.waitFor(
      (message) => {
        if (
          message.type === "machine_spawn_agent"
          && message.channelId === channelId
          && isSpawnOf(message, registration)
        ) {
          sawSpawn = true;
          return true;
        }
        return false;
      },
      "unexpected bare product spawn",
      2_500,
    ).catch(() => null);

    const response = await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: "@codex-bare-route:new investigate the failure" }),
    });
    assert.equal(response.status, 200);

    const notice = await waitForChannelHistoryMessage(
      worker,
      MOCK_TOKEN,
      channelId,
      (message) =>
        typeof message.body === "string"
        && message.body.includes("launch suffixes are retired"),
      "retirement system notice for bare :new",
      20_000,
    );
    assert.match(notice.body, /@auto repo:owner\/repo/u);

    await spawnWatch;
    assert.equal(sawSpawn, false, "bare product :new must not issue machine_spawn_agent");

    // No createRun/createInstance path runs on bare rejection. Prove it via the
    // product channel catalog presence surface (same source as reconnect e2e).
    const catalog = await json(await worker.fetch("/api/channels", { headers: auth }));
    const listed = catalog.channels.find((candidate) => candidate.id === channelId);
    assert.ok(listed, "channel must remain listable after bare :new rejection");
    assert.deepEqual(Object.keys(listed.memberPresence ?? {}), [], "bare :new must leave the Channel with no Agent member");

    const history = await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/history?limit=20`,
      { headers: auth },
    ));
    const agentSpawnMessages = (history.messages || []).filter((message) => message.from?.kind === "agent");
    assert.equal(agentSpawnMessages.length, 0, "bare :new must not produce agent channel messages");
  } finally {
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});

test("tagged Auto workspace launch completes daemon spawn, mock Agent registration, join, and reply", async () => {
  const userId = `agent-summon-e2e-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "agent-summon-e2e@example.com", name: "Agent Summon E2E" });
  let daemon;
  let agent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("agent-summon");
    const canonicalCwd = `/tmp/xmatrix agent summon ${randomUUID()}`;
    const channelId = (await createClosedChannel(worker, `agent-summon-${randomUUID()}`)).id;
    daemon = await connectDaemon(worker, { machineId, hostId });
    const workspace = await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: "agent-summon-workspace" });
    const registration = await registerTestAgent(worker, { token: MOCK_TOKEN,
      spaceId: await channelSpaceId(channelId), machineId, displayName: "codex-current-route", canonicalCwd });
    const spawn = daemon.inbox.waitFor(
      (message) => message.channelId === channelId && isSpawnOf(message, registration),
      "Authority-owned machine spawn",
    );
    await postAutoLaunch(worker, { channelId, machineId, canonicalCwd }, "investigate the failure");
    const command = await spawn;
    assert.equal(command.agentName, "codex-current-route");
    assert.equal(command.workspace.machineId, machineId);
    assert.equal(command.workspace.hostId, hostId);
    assert.equal(command.workspace.machineId, workspace.machineId);
    assert.equal(command.workspace.canonicalCwd, canonicalCwd);
    assert.equal(command.runWorktree, undefined);
    assert.doesNotMatch(command.prompt, /@codex-current-route:new/);
    // The summoning message only reaches the Instance as its prompt, so the
    // spawn must name it: without the id nothing ever acknowledges that message
    // and every catch-up replays it as new work.
    const summoned = await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/history?limit=50`,
      { headers: auth },
    ));
    const summoningMessage = (summoned.messages || []).find(
      (message) => message.body.includes("investigate the failure"),
    );
    assert.ok(summoningMessage, "the summoning message should be in channel history");
    assert.equal(command.sourceMessageId, summoningMessage.messageId);
    const evidenceDatabase = new Client({ connectionString: testPostgresUrl() });
    await evidenceDatabase.connect();
    try {
      const stored = await evidenceDatabase.query(`SELECT r.ref_id,r.root_set_id,o.storage_key
        FROM data.content_refs r JOIN data.content_objects o
          ON o.space_id=r.space_id AND o.object_id=r.child_object_id
        WHERE r.owner_kind='summon_decision' AND r.owner_id=$1 ORDER BY r.ref_id`, [summoningMessage.messageId]);
      assert.equal(stored.rows.length, 4, "both actual Jev stages persist input and success before spawn");
      assert.equal(stored.rows.filter(row => row.ref_id.endsWith(':started')).length, 2);
      assert.equal(stored.rows.filter(row => row.ref_id.endsWith(':succeeded')).length, 2);
      assert.ok(stored.rows.every(row => row.root_set_id.startsWith('channel-user:') && row.storage_key.startsWith('restricted/')));
      const evidenceUrl = `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(summoningMessage.messageId)}/decision-evidence`;
      const listing = await json(await worker.fetch(evidenceUrl, { headers: auth }));
      assert.equal(listing.records.length, 4);
      const runToken = await mintAgentRunToken(worker, daemon, command, channelId);
      const agentAuth = { Authorization: `Bearer ${runToken}` };
      const agentListing = await json(await worker.fetch(evidenceUrl, { headers: agentAuth }));
      assert.deepEqual(agentListing.records, listing.records, "an authorized Run can inspect Human routing evidence");
      const agentDownload = await worker.fetch(`${evidenceUrl}?refId=${encodeURIComponent(listing.records[0].refId)}`, { headers: agentAuth });
      assert.equal(agentDownload.status, 200);
      assert.equal((await agentDownload.json()).sourceMessageId, summoningMessage.messageId);
      const target = (await json(await worker.fetch("/api/channels", {
        method: "POST", headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ spaceId: await homeSpaceId(worker), mode: "open", name: `collaboration-${randomUUID()}`, access: [] }),
      }))).channel;
      assert.equal((await worker.fetch(`/api/channels/${target.id}/join`, {
        method: "POST", headers: { ...agentAuth, "content-type": "application/json" }, body: "{}",
      })).status, 200);
      const crossSpawn = daemon.inbox.waitFor(message => message.type === "machine_spawn_agent"
        && message.channelId === target.id, "Agent-authored cross-channel summon");
      const crossMessage = await worker.fetch(`/api/channels/${target.id}/messages`, {
        method: "POST", headers: { ...agentAuth, "content-type": "application/json" },
        body: JSON.stringify({ body: `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}" reply once` }),
      });
      assert.equal(crossMessage.status, 200, await crossMessage.clone().text());
      assert.equal((await crossSpawn).channelId, target.id);
      assert.doesNotMatch(JSON.stringify(listing), /storage_key|objectKey|privateDirectory/);
      for (const record of listing.records.filter(record => record.refId.endsWith(':started'))) {
        const downloaded = await worker.fetch(`${evidenceUrl}?refId=${encodeURIComponent(record.refId)}`, { headers: auth });
        assert.equal(downloaded.status, 200);
        assert.match(downloaded.headers.get('cache-control'), /no-store/);
        const payload = await downloaded.json();
        assert.equal(payload.sourceMessageId, summoningMessage.messageId);
        assert.match(payload.inputDigest, /^[a-f0-9]{64}$/);
        assert.match(payload.input.state.message, /investigate the failure/);
      }
      // The Run connects and speaks before its owner's membership is revoked
      // below: revocation may fence it, so nothing after that relies on it.
      agent = await connectSpawnedMockAgent(worker, daemon, command, channelId);
      const delivered = await agent.reply("The agent is running on the requested machine.");
      assert.equal(delivered.from.identityId, `agent:${command.identityId}`, "an Instance speaks under its agent: identity");
      const revoked = await evidenceDatabase.query(`DELETE FROM data.space_members
        WHERE user_id=$1 AND space_id=(SELECT space_id FROM data.channels WHERE channel_id=$2) RETURNING *`, [userId, channelId]);
      assert.equal(revoked.rows.length, 1);
      try {
        assert.equal((await worker.fetch(evidenceUrl, { headers: auth })).status, 404);
        // The Channel's coordinator fences a Run whose owner lost access on its
        // next pass. Until then the Run finds no Channel (404); once fenced, the
        // Run itself is refused before any Channel lookup (403). Either way the
        // Agent reaches nothing, and nothing else is acceptable.
        const assertAgentRefused = async (response, label) => {
          const payload = await response.clone().json().catch(() => ({}));
          assert.ok(response.status === 404 || (response.status === 403 && payload.code === "agent_run_forbidden"),
            `${label}: ${response.status} ${JSON.stringify(payload)}`);
        };
        await assertAgentRefused(await worker.fetch(evidenceUrl, { headers: agentAuth }), "Agent evidence read");
        await assertAgentRefused(await worker.fetch(`/api/channels/${target.id}/join`, {
          method: "POST", headers: { ...agentAuth, "content-type": "application/json" }, body: "{}",
        }), "Agent join");
        assert.equal((await worker.fetch(`${evidenceUrl}?refId=${encodeURIComponent(listing.records[0].refId)}`, { headers: auth })).status, 404);
      } finally {
        await evidenceDatabase.query('INSERT INTO data.space_members SELECT * FROM jsonb_populate_record(NULL::data.space_members,$1::jsonb)', [JSON.stringify(revoked.rows[0])]);
      }
      await evidenceDatabase.query(`UPDATE data.content_refs SET created_at=now()-interval '31 days'
        WHERE owner_kind='summon_decision' AND owner_id=$1`, [summoningMessage.messageId]);
      assert.deepEqual((await json(await worker.fetch(evidenceUrl, { headers: auth }))).records, []);
      assert.equal((await worker.fetch(`${evidenceUrl}?refId=${encodeURIComponent(listing.records[0].refId)}`, { headers: auth })).status, 404);
      await evidenceDatabase.query(`INSERT INTO data.content_refs
        SELECT (jsonb_populate_record(NULL::data.content_refs, to_jsonb(r) ||
          jsonb_build_object('ref_id','retained-other-owner','owner_kind','attachment'))).*
        FROM data.content_refs r WHERE r.ref_id=$1`, [listing.records[0].refId]);
      await evidenceDatabase.query(`INSERT INTO data.content_refs
        SELECT (jsonb_populate_record(NULL::data.content_refs, to_jsonb(r) ||
          jsonb_build_object('ref_id','retained-current-decision','owner_id','other-source-message','created_at',now()))).*
        FROM data.content_refs r WHERE r.ref_id=$1`, [listing.records[0].refId]);
      const maintenance = createAuthorityDatabase({ connectionString: testPostgresUrl(), shardId: "shard-0" }).openSession();
      try {
        const content = new PostgresContentRepository(maintenance, "shard-0");
        const spaceId = (await evidenceDatabase.query('SELECT space_id FROM data.channels WHERE channel_id=$1', [channelId])).rows[0].space_id;
        assert.ok(await content.nextDecisionMaintenance({ requestId: randomUUID(), spaceId }) <= Date.now());
        assert.equal((await content.expireDecisionRefs({ requestId: randomUUID(), spaceId, limit: 2 })).expired, 2);
        assert.equal((await content.expireDecisionRefs({ requestId: randomUUID(), spaceId, limit: 2 })).expired, 2);
        assert.equal((await content.expireDecisionRefs({ requestId: randomUUID(), spaceId, limit: 2 })).expired, 0);
        assert.ok(await content.nextDecisionMaintenance({ requestId: randomUUID(), spaceId }) > Date.now());
        const nominations = await evidenceDatabase.query(`SELECT * FROM data.content_gc_candidates
          WHERE space_id=$1 AND reason='decision-expired'`, [spaceId]);
        assert.equal(nominations.rows.length, 3);
        assert.equal((await evidenceDatabase.query("SELECT ref_id FROM data.content_refs WHERE ref_id='retained-other-owner'")).rows.length, 1);
        assert.ok(nominations.rows.every(row => row.status === 'pending' && new Date(row.not_before).getTime() > Date.now()));
        assert.equal((await evidenceDatabase.query("SELECT ref_id FROM data.content_refs WHERE ref_id='retained-current-decision'")).rows.length, 1);
        const audit = await evidenceDatabase.query(`SELECT count(*)::int AS count FROM data.idempotency_keys
          WHERE space_id=$1 AND command_kind='expire-decision-refs'`, [spaceId]);
        assert.equal(audit.rows[0].count, 2);
        const target = nominations.rows[0];
        const claim = () => content.claimDecisionObject({ requestId: randomUUID(), spaceId, objectKey: target.storage_key });
        assert.equal(await claim(), null, 'safety window prevents early physical deletion');
        await evidenceDatabase.query(`UPDATE data.content_gc_candidates SET not_before=now()-interval '1 second' WHERE space_id=$1`, [spaceId]);
        await evidenceDatabase.query(`UPDATE data.content_objects SET gc_not_before=now()-interval '1 second' WHERE space_id=$1`, [spaceId]);
        const uploadScope = decodeURIComponent(target.storage_key.split('/')[1]);
        await evidenceDatabase.query(`INSERT INTO data.blob_upload_intents
          (space_id,intent_id,scope_id,content_hash,object_key,encoded_bytes,checksum,status,version,created_at,expires_at)
          VALUES ($1,'gc-inflight',$2,$3,$4,10,$3,'pending',1,now()-interval '2 hours',now()-interval '1 hour')`,
          [spaceId,uploadScope,target.content_hash,target.storage_key]);
        assert.equal(await claim(), null, 'even an expired intent needs retirement before bytes can be collected');
        await evidenceDatabase.query("DELETE FROM data.blob_upload_intents WHERE intent_id='gc-inflight'");
        const otherSession = createAuthorityDatabase({ connectionString: testPostgresUrl(), shardId: 'shard-0' }).openSession();
        let lease;
        try {
          const claims = await Promise.all([claim(), new PostgresContentRepository(otherSession, 'shard-0')
            .claimDecisionObject({ requestId: randomUUID(), spaceId, objectKey: target.storage_key })]);
          assert.equal(claims.filter(Boolean).length, 1, 'only one concurrent collector acquires the object');
          lease = claims.find(Boolean);
        } finally { await otherSession.close(); }
        const scopeId = decodeURIComponent(target.storage_key.split('/')[1]);
        await assert.rejects(content.createIntent({ requestId: randomUUID(), commandId: randomUUID(), intentId: randomUUID(),
          scopeId, contentHash: target.content_hash, encodedBytes: 10, expiresAt: new Date(Date.now()+60000).toISOString(),
          principal: { kind: 'user', id: userId } }), error => error.code === 'content_object_retired');
        await assert.rejects(content.commitRef({ requestId: randomUUID(), commandId: randomUUID(), intentId: randomUUID(),
          scopeId, refId: randomUUID(), ownerKind: 'summon_decision', ownerId: summoningMessage.messageId,
          expectedIntentVersion: 1, objectKey: target.storage_key, checksum: target.content_hash, encodedBytes: 10,
          verifiedAt: new Date().toISOString(), principal: { kind: 'user', id: userId } }), error => error.code === 'content_object_retired');
        await evidenceDatabase.query(`UPDATE data.content_gc_candidates SET lease_until=now()-interval '1 second'
          WHERE space_id=$1 AND object_id=$2`, [spaceId,target.object_id]);
        const retry = await claim();
        assert.ok(retry.version > lease.version, 'expired lease is resumable');
        assert.equal(await content.completeDecisionObject({ requestId: randomUUID(), spaceId, objectId: lease.objectId, version: lease.version }), false);
        assert.equal(await content.completeDecisionObject({ requestId: randomUUID(), spaceId, objectId: retry.objectId, version: retry.version }), true);
        assert.equal(await claim(), null, 'deleted tombstone cannot be reclaimed');
        const orphanId = randomUUID(), ordinaryId = randomUUID();
        for (const [intentId, purpose, checksum] of [[orphanId,'summon_decision','e'.repeat(64)], [ordinaryId,undefined,'f'.repeat(64)]]) {
          await content.createIntent({ requestId: randomUUID(), commandId: randomUUID(), intentId, scopeId,
            contentHash: checksum, encodedBytes: 10, expiresAt: new Date(Date.now()+60000).toISOString(),
            principal: { kind: 'user', id: userId }, ...(purpose ? { purpose } : {}) });
        }
        await assert.rejects(content.readIntent({ requestId: randomUUID(), intentId: orphanId,
          principal: { kind: 'user', id: userId } }), error => error.code === 'decision_writer_required');
        assert.equal(await content.retireDecisionUploads({ requestId: randomUUID(), spaceId }), 0, 'fresh upload is retained');
        await evidenceDatabase.query(`UPDATE data.blob_upload_intents SET created_at=now()-interval '34 days',
          expires_at=now()-interval '33 days' WHERE intent_id=ANY($1::text[])`, [[orphanId,ordinaryId]]);
        assert.equal(await content.retireDecisionUploads({ requestId: randomUUID(), spaceId }), 1);
        assert.equal(await content.retireDecisionUploads({ requestId: randomUUID(), spaceId }), 0);
        assert.equal((await evidenceDatabase.query('SELECT intent_id FROM data.blob_upload_intents WHERE intent_id=$1', [ordinaryId])).rows.length, 1);
        const orphan = (await evidenceDatabase.query(`SELECT * FROM data.content_gc_candidates
          WHERE space_id=$1 AND content_hash=$2`, [spaceId,'e'.repeat(64)])).rows[0];
        assert.equal(orphan.reason, 'decision-upload-expired');
        await evidenceDatabase.query('UPDATE data.content_gc_candidates SET not_before=now() WHERE space_id=$1 AND object_id=$2', [spaceId,orphan.object_id]);
        await evidenceDatabase.query('UPDATE data.content_gc_candidates SET content_hash=$1 WHERE space_id=$2 AND object_id=$3', ['d'.repeat(64),spaceId,orphan.object_id]);
        await assert.rejects(content.claimDecisionObject({ requestId: randomUUID(), spaceId, objectKey: orphan.storage_key }), error => error.code === 'invalid_decision_storage');
        await evidenceDatabase.query('UPDATE data.content_gc_candidates SET content_hash=$1 WHERE space_id=$2 AND object_id=$3', ['e'.repeat(64),spaceId,orphan.object_id]);
        const orphanLease = await content.claimDecisionObject({ requestId: randomUUID(), spaceId, objectKey: orphan.storage_key });
        assert.ok(orphanLease, 'uploaded bytes without a committed content object can be collected');
        assert.equal(await content.completeDecisionObject({ requestId: randomUUID(), spaceId, objectId: orphanLease.objectId, version: orphanLease.version }), true);


      } finally { await maintenance.close(); }

    } finally { await evidenceDatabase.end(); }
  } finally {
    await stopAgentWorker(worker, agent, daemon);
  }
});

test("Space members and their Agent Runs can discover and launch each other's Agents", async () => {
  const ownerToken = `owner-token-${randomUUID()}`;
  const memberToken = `member-token-${randomUUID()}`;
  const outsiderToken = `outsider-token-${randomUUID()}`;
  const ownerUserId = `workspace-owner-${randomUUID()}`;
  const memberUserId = `workspace-member-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
        [ownerToken]: {
          id: ownerUserId,
          email: `${ownerUserId}@example.com`,
          name: "Workspace Owner",
        },
        [memberToken]: {
          id: memberUserId,
          email: `${memberUserId}@example.com`,
          name: "Workspace Member",
        },
        [outsiderToken]: {
          id: `workspace-outsider-${randomUUID()}`,
          email: "workspace-outsider@example.com",
          name: "Workspace Outsider",
        },
      }),
    },
  });
  let daemon;
  let memberDaemon;
  let sourceAgent;
  try {
    const ownerAuth = {
      Authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json",
    };
    const memberAuth = {
      Authorization: `Bearer ${memberToken}`,
      "content-type": "application/json",
    };
    const { hostId, machineId } = testMachine("cross-user");
    const canonicalCwd = `/tmp/xmatrix-cross-user-${randomUUID()}`;
    const memberHostId = `cross-user-member-host-${randomUUID()}`;
    const memberMachineId = `machine:cross-user-member-${randomUUID()}`;
    const memberCanonicalCwd = `/tmp/xmatrix-cross-user-member-${randomUUID()}`;
    const space = await createSpace(worker, `Cross-user launch ${randomUUID()}`, ownerToken);
    const invite = await inviteToSpace(worker, space.id, ownerToken);
    const invitation = await json(await worker.fetch(
      `/api/space-invites/${encodeURIComponent(invite.token)}`,
    ));
    assert.equal(invitation.invite.spaceId, space.id);
    assert.equal(invitation.invite.token, undefined, "public invite view must not echo its bearer secret");
    assert.equal((await worker.fetch(`/api/space-invites/${"0".repeat(64)}`)).status, 404,
      "a well-shaped but unknown token must not grant an invite");
    await acceptSpaceInvite(worker, invite, memberToken);
    const channel = (await json(await worker.fetch("/api/channels", {
      method: "POST",
      headers: ownerAuth,
      body: JSON.stringify({ spaceId: space.id, mode: "open", name: `cross-user-${randomUUID()}` }),
    }))).channel;
    daemon = await connectDaemon(worker, { machineId, hostId }, ownerToken);
    memberDaemon = await connectDaemon(worker, { machineId: memberMachineId, hostId: memberHostId }, memberToken);
    const workspace = (await json(await worker.fetch("/api/workspaces", {
      method: "POST",
      headers: ownerAuth,
      body: JSON.stringify({
        machineId,
        hostId,
        hostName: hostId,
        canonicalCwd,
        displayName: "cross-user-workspace",
        gitRemote: "https://github.com/LambdaLabsHQ/xmatrix.git",
        runtime: "codex",
      }),
    }))).workspace;
    const registration = await registerTestAgent(worker, { token: ownerToken, spaceId: space.id, machineId,
      displayName: "codex-cross-user-route", canonicalCwd });
    const memberWorkspaces = await json(await worker.fetch("/api/workspaces", {
      headers: { Authorization: `Bearer ${memberToken}` },
    }));
    assert.equal(memberWorkspaces.workspaces.length, 0, "the general registry stays owner-scoped");

    /* A registered directory is a path on somebody's machine. Another member of
       the Space reads none of it, and with no connector configured here the
       Space authorizes no repo either, which the answer says rather than
       leaving it to be guessed from an empty list. */
    const launchTargetsRoute = `/api/spaces/${encodeURIComponent(space.id)}/launch-targets`;
    const memberView = await json(await worker.fetch(launchTargetsRoute,
      { headers: { Authorization: `Bearer ${memberToken}` } }));
    assert.equal(memberView.spaceId, space.id);
    assert.deepEqual(memberView.workspaces, [], "another owner's paths are never revealed");
    assert.equal(memberView.repoStatus, "not-connected");
    assert.deepEqual(memberView.repos, []);
    const ownerView = await json(await worker.fetch(launchTargetsRoute, { headers: ownerAuth }));
    assert.deepEqual(ownerView.workspaces.map(candidate => candidate.canonicalCwd), [canonicalCwd]);
    assert.equal(ownerView.workspaces[0].ownerUserId, ownerUserId);
    assert.notEqual((await worker.fetch(launchTargetsRoute,
      { headers: { Authorization: `Bearer ${outsiderToken}` } })).status, 200,
      "a non-member cannot discover the Space's launch targets");


    const memberWorkspace = (await json(await worker.fetch("/api/workspaces", {
      method: "POST",
      headers: memberAuth,
      body: JSON.stringify({
        machineId: memberMachineId,
        hostId: memberHostId,
        hostName: memberHostId,
        canonicalCwd: memberCanonicalCwd,
        displayName: "cross-user-member-workspace",
        gitRemote: "https://github.com/LambdaLabsHQ/xmatrix.git",
        runtime: "codex",
      }),
    }))).workspace;
    const memberRegistration = await registerTestAgent(worker, { token: memberToken, spaceAdminToken: ownerToken,
      spaceId: space.id, machineId: memberMachineId, displayName: "codex-cross-user-member-route",
      canonicalCwd: memberCanonicalCwd });

    const spawn = daemon.inbox.waitFor(
      (message) => message.channelId === channel.id && isSpawnOf(message, registration),
      "cross-user Authority-owned machine spawn",
    );
    const response = await worker.fetch(
      `/api/channels/${encodeURIComponent(channel.id)}/messages`,
      {
        method: "POST",
        headers: memberAuth,
        body: JSON.stringify({
          body: `@auto harness:codex machine:${machineId} investigate the failure`,
        }),
      },
    );
    assert.equal(response.status, 200);
    const command = await spawn;
    assert.equal(command.workspace.ownerUserId, workspace.ownerUserId);
    assert.equal(command.workspace.machineId, machineId);
    // This fixture has no repository connector. Resolve the owner's published
    // registered directory without granting access to their directory catalog.
    assert.equal(command.workspace.canonicalCwd, canonicalCwd);
    assert.equal(command.remoteRepo, undefined);

    const runToken = await mintAgentRunToken(worker, daemon, command, channel.id);
    sourceAgent = await connectAgent(worker, runAgentConnection(command, channel.id, { machineId, hostId }), runToken);
    const joined = await sourceAgent.request({
      type: "join_channel",
      channelId: channel.id,
      historyLimit: 0,
    });
    assert.equal(joined.type, "channel_joined");

    const liveInstances = await json(await worker.fetch("/api/agent-instances", {
      headers: { Authorization: `Bearer ${runToken}` },
    }));
    assert.ok(
      liveInstances.instances.some((candidate) => candidate.instanceId === command.instanceId),
      "xmatrix list can see a live Agent in an authorized channel",
    );

    const delegatedSpawn = memberDaemon.inbox.waitFor(
      (message) => message.channelId === channel.id && isSpawnOf(message, memberRegistration),
      "Agent-to-Agent cross-user machine spawn",
    );
    // Live Agent replies use the Runtime WebSocket append path, not Hub HTTP.
    // Authority must schedule the same tagged launch interpretation for Agents.
    const delegatedDispatch = await sourceAgent.request({
      type: "channel_message",
      channelId: channel.id,
      body: `@auto harness:codex machine:${memberMachineId} investigate as a delegate`,
    });
    assert.equal(delegatedDispatch.type, "channel_message_dispatched");
    const delegatedCommand = await delegatedSpawn;
    assert.equal(delegatedCommand.workspace.ownerUserId, memberWorkspace.ownerUserId);
    assert.equal(delegatedCommand.workspace.machineId, memberMachineId);
    assert.equal(delegatedCommand.remoteRepo, undefined);
    assert.equal(delegatedCommand.workspace.canonicalCwd, memberCanonicalCwd);
  } finally {
    if (sourceAgent) sourceAgent.ws.close();
    if (memberDaemon) memberDaemon.ws.close();
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});

test("tagged rejection is persisted and queryable through the real Hub without a Run", async () => {
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USER_ID: `preflight-${randomUUID()}`, XMATRIX_MOCK_AUTH_EMAIL: 'preflight@example.test',
    XMATRIX_MOCK_AUTH_NAME: 'Preflight E2E' } });
  try {
    const headers = { Authorization: `Bearer ${MOCK_TOKEN}`, 'content-type': 'application/json' };
    const channel = await json(await worker.fetch('/api/channels', { method: 'POST', headers,
      body: JSON.stringify({ spaceId: await homeSpaceId(worker), mode: 'closed', name: `preflight-${randomUUID()}`, access: [] }) }));
    const channelId = channel.channel.id;
    const body = '@auto machine:nonexistent-observability-test';
    await json(await worker.fetch(`/api/channels/${channelId}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ body }) }));
    const history = await json(await worker.fetch(`/api/channels/${channelId}/history?limit=20`, { headers }));
    const sourceMessageId = history.messages.find(message => message.body === body)?.messageId;
    assert.equal(typeof sourceMessageId, 'string');
    // The refusal is recorded against the mention, where the message shows it.
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await json(await worker.fetch(`/api/channels/${channelId}/agent-launches/query`, {
        method: 'POST', headers, body: JSON.stringify({ sourceMessageIds: [sourceMessageId], pageSize: 20 }) }));
      if (result.rejections?.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(result.launches, []);
    assert.equal(result.rejections.length, 1);
    assert.equal(result.rejections[0].sourceMention, body);
    assert.equal(result.rejections[0].code, 'registration_not_found');
  } finally { await worker.stop(); }
});
