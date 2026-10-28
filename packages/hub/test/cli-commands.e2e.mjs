import { Client } from "pg";
import { createAuthorityDatabase, PostgresContentRepository } from "../../db/dist/index.js";
import { restrictedChannelContentScope } from "@xmatrix/protocol";
import { acceptSpaceInvite, channelSpaceId, createPgSpawnableScenario, inviteToSpace, isSpawnOf, startPgHubWorker, testPostgresUrl } from "./agent-launch-postgres.fixture.mjs";
import { assert, channelHistory, mintAgentRunToken, MOCK_TOKEN, postChannelMessage, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";

const run = async (worker, token, argv) => {
  const response = await worker.fetch("/api/cli/commands/run", { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ argv }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};

test("Hub commands answer a person and a Run through the Hub's own routes", async () => {
  const ownerId = `cli-commands-${randomUUID()}`, otherId = `cli-other-${randomUUID()}`;
  const otherToken = `cli-other-token-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USER_ID: ownerId, XMATRIX_MOCK_AUTH_EMAIL: "cli-commands@example.com",
    XMATRIX_MOCK_AUTH_NAME: "CLI Commands", XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
      [MOCK_TOKEN]: { id: ownerId, email: "cli-commands@example.com", name: "CLI Commands" },
      [otherToken]: { id: otherId, email: "cli-other@example.com", name: "Other administrator" },
    }) } });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-cli-commands" });
    ({ daemon } = scenario);
    const { channelId, registration, machineId, canonicalCwd } = scenario;

    assert.deepEqual(await run(worker, MOCK_TOKEN, ["logn"]), { unknownCommand: true });
    const listing = await run(worker, MOCK_TOKEN, ["commands"]);
    assert.equal(listing.exitCode, 0);
    assert.match(listing.stdout, /automation pause\s+Pause an Automation/);
    assert.match(listing.stdout, /call\s+Call a connected app read action with public or private results/);
    const privateHelp = await run(worker, MOCK_TOKEN, ["call", "--help"]);
    assert.match(privateHelp.stdout, /calling Agent and its Human owner/);
    const humanCall = await run(worker, MOCK_TOKEN, ["call", "@gmail:read:18f2a9c0d1e2b3a4", "--private"]);
    assert.equal(humanCall.exitCode, 1);
    assert.match(humanCall.stderr, /require an Agent Run/);
    const list = await run(worker, MOCK_TOKEN, ["automation", "list", "--channel", channelId]);
    assert.deepEqual(list, { stdout: "", exitCode: 0 });

    await postChannelMessage(worker, MOCK_TOKEN, channelId,
      `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}" list automations`);
    const spawn = await daemon.inbox.waitFor((message) => message.type === "machine_spawn_agent" &&
      message.channelId === channelId && isSpawnOf(message, registration), "machine spawn");
    const runToken = await mintAgentRunToken(worker, daemon, spawn, channelId);
    const asRun = await run(worker, runToken, ["automation", "list", "--channel", channelId, "--json"]);
    assert.equal(asRun.exitCode, 0, asRun.stderr);
    assert.deepEqual(JSON.parse(asRun.stdout), []);
    const privateRead = await run(worker, runToken, ["call", "@gmail:read:18f2a9c0d1e2b3a4", "--private"]);
    assert.equal(privateRead.exitCode, 1);
    assert.match(privateRead.stderr, /connect Gmail/);
    const history = await channelHistory(worker, MOCK_TOKEN, channelId);
    const invocation = history.messages.find(message => message.body === "@gmail:read:18f2a9c0d1e2b3a4");
    assert.ok(invocation, "the authenticated Run's call is a normal persisted Channel invocation");
    assert.equal(invocation.from.kind, "agent");
    const receipt = history.messages.find(message => message.replyToMessageId === invocation.messageId);
    assert.ok(receipt, "a denied private call still has a threaded result receipt");
    // The Hub's own next step carries no provider data, so even a private call shows it.
    assert.match(receipt.body, /Gmail read: blocked; connect Gmail to this Space first/);
    // The real authority and R2 reader protect originals from other members and Agent Runs.
    const ownerAuth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const privateUrl = `/api/channels/${channelId}/messages/${encodeURIComponent(receipt.messageId)}/connector-result`;
    const original = await worker.fetch(privateUrl, { headers: ownerAuth });
    assert.equal(original.status, 200, await original.clone().text());
    assert.equal(original.headers.get("cache-control"), "private, no-store");
    assert.match((await original.json()).detail, /connect Gmail/);
    const deniedRun = await worker.fetch(privateUrl, { headers: { Authorization: `Bearer ${runToken}` } });
    assert.ok([401, 403].includes(deniedRun.status));
    assert.doesNotMatch(await deniedRun.text(), /connect Gmail/);
    const spaceId = await channelSpaceId(channelId);
    const opened = await worker.fetch(`/api/channels/${channelId}`, { method: "PATCH", headers: ownerAuth,
      body: JSON.stringify({ mode: "open" }) });
    assert.equal(opened.status, 200, await opened.clone().text());
    await acceptSpaceInvite(worker, await inviteToSpace(worker, spaceId, MOCK_TOKEN, "admin"), otherToken);
    const otherHistory = await channelHistory(worker, otherToken, channelId);
    assert.ok(otherHistory.messages.some(row => row.messageId === receipt.messageId));
    assert.doesNotMatch(otherHistory.messages.find(row => row.messageId === receipt.messageId).body, /connect Gmail/);
    const otherRead = await worker.fetch(privateUrl, { headers: { Authorization: `Bearer ${otherToken}` } });
    assert.equal(otherRead.status, 404);
    assert.doesNotMatch(await otherRead.text(), /connect Gmail/);

    const database = new Client({ connectionString: testPostgresUrl() });
    await database.connect();
    const session = createAuthorityDatabase({ connectionString: testPostgresUrl(), shardId: "shard-0" }).openSession();
    const content = new PostgresContentRepository(session, "shard-0");
    try {
      await assert.rejects(content.readRef({ requestId: randomUUID(), refId: `connector-result:${receipt.messageId}`,
        principal: { kind: "user", id: ownerId } }), error => error.code === "private_record_reader_required");
      const member = (await database.query("DELETE FROM data.space_members WHERE space_id=$1 AND user_id=$2 RETURNING *",
        [spaceId, ownerId])).rows[0];
      assert.ok(member);
      try { assert.equal((await worker.fetch(privateUrl, { headers: ownerAuth })).status, 404); }
      finally { await database.query("INSERT INTO data.space_members SELECT * FROM jsonb_populate_record(NULL::data.space_members,$1::jsonb)", [JSON.stringify(member)]); }
      assert.equal((await worker.fetch(privateUrl, { headers: ownerAuth })).status, 200);
      await database.query("UPDATE data.messages SET recalled_at=now() WHERE channel_id=$1 AND message_id=$2", [channelId,receipt.messageId]);
      assert.equal((await worker.fetch(privateUrl, { headers: ownerAuth })).status, 404);
      await database.query("UPDATE data.messages SET recalled_at=NULL WHERE channel_id=$1 AND message_id=$2", [channelId,receipt.messageId]);
      await database.query("UPDATE data.content_refs SET created_at=now()-interval '31 days' WHERE ref_id=$1", [`connector-result:${receipt.messageId}`]);
      assert.equal((await worker.fetch(privateUrl, { headers: ownerAuth })).status, 404);
      assert.ok(await content.nextDecisionMaintenance({ requestId: randomUUID(), spaceId }) <= Date.now());
      assert.equal((await content.expireDecisionRefs({ requestId: randomUUID(), spaceId, limit: 50 })).expired, 1);
      const orphanId = randomUUID();
      await content.createIntent({ requestId: randomUUID(), commandId: randomUUID(), intentId: orphanId,
        purpose: "connector_result", scopeId: restrictedChannelContentScope(channelId, ownerId), contentHash: "d".repeat(64),
        encodedBytes: 10, expiresAt: new Date(Date.now()+60000).toISOString(), principal: { kind: "user", id: ownerId } });
      await assert.rejects(content.readIntent({ requestId: randomUUID(), intentId: orphanId,
        principal: { kind: "user", id: ownerId } }), error => error.code === "private_record_writer_required");
      await database.query("UPDATE data.blob_upload_intents SET created_at=now()-interval '34 days', expires_at=now()-interval '33 days' WHERE intent_id=$1", [orphanId]);
      assert.equal(await content.retireDecisionUploads({ requestId: randomUUID(), spaceId }), 1);
    } finally { await session.close(); await database.end(); }
    const refused = await run(worker, runToken, ["automation", "pause", "missing", "--version", "1"]);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /^error: .*\(HTTP 4\d\d\)\n$/);
  } finally {
    daemon?.ws.close();
    await worker.stop();
  }
});
