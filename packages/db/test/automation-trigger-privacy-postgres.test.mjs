import assert from "node:assert/strict";
import { createAuthorityDatabase, PostgresAutomationRepository, PostgresPageRepository } from "../dist/index.js";
import { integration } from "./postgres-database.fixture.mjs";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";

// The author may receive an event while a different Page reader may not use
// Space credentials. Existing trigger tests checked the author, not readers.
integration("private trigger summaries follow each reader's current Space role across Automation catalogs", async () => {
  const f = await spaceSecretFixture();
  const database = createAuthorityDatabase({ connectionString: process.env.XMATRIX_TEST_POSTGRES_URL,
    shardId: "shard-0", applicationName: "automation-trigger-privacy-test" });
  const automations = new PostgresAutomationRepository(database);
  const automationId = crypto.randomUUID();
  try {
    await f.client.query(`INSERT INTO data.space_control_heads(space_id,commit_sequence,updated_at)
      VALUES($1,0,now()) ON CONFLICT DO NOTHING`, [f.ids.space]);
    const { page } = await new PostgresPageRepository(database).create({ requestId: crypto.randomUUID(),
      spaceId: f.ids.space, principal: { kind: "user", id: f.ids.owner }, title: "Synthetic privacy audit",
      body: `[Synthetic automation](xmatrix:automation/${automationId})` });
    // An existing enabled Automation, with a live member author and a real Page.
    await f.client.query(`INSERT INTO data.automations
      (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,payload_json,page_id,created_at,updated_at)
      VALUES($1,$2,$3,now()+interval '1 day',true,1,$4::jsonb,$5,now(),now())`,
    [automationId, f.ids.owner, f.ids.channel, JSON.stringify({ payloadVersion: 2, name: "Synthetic audit",
      intervalMinutes: 60, message: { body: "@auto synthetic audit" },
      input: { envRef: { authorityRootUserId: f.ids.owner } },
      triggers: [{ kind: "event", provider: "slack", source: "*" }] }), page.pageId]);
    await automations.fireTrigger({ requestId: crypto.randomUUID(), automationId, eventId: crypto.randomUUID(),
      event: { kind: "event", summary: "SYNTHETIC-PRIVATE-SUMMARY", url: "https://example.invalid/private-event" },
      at: new Date().toISOString() });
    const reads = userId => [
      automations.listPage({ requestId: crypto.randomUUID(), spaceId: f.ids.space, pageId: page.pageId, userId }),
      automations.list({ requestId: crypto.randomUUID(), spaceId: f.ids.space, principal: { kind: "user", id: userId } }),
      automations.get({ requestId: crypto.randomUUID(), automationId, principal: { kind: "user", id: userId } }),
    ];
    for (const result of await Promise.all(reads(f.ids.admin))) {
      assert.match(JSON.stringify(result), /SYNTHETIC-PRIVATE-SUMMARY/u, "an authorized reader sees the event");
    }
    for (const role of ["participant", "viewer"]) {
      await f.client.query("UPDATE data.space_members SET role=$3 WHERE space_id=$1 AND user_id=$2",
        [f.ids.space, f.ids.admin, role]);
      for (const result of await Promise.all(reads(f.ids.admin))) {
        assert.match(JSON.stringify(result), /Synthetic audit/u, "the readable Automation stays listed");
        assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-PRIVATE-SUMMARY|private-event/u, role);
      }
    }
    const { rows } = await f.client.query("SELECT trigger_events FROM data.automations WHERE automation_id=$1", [automationId]);
    assert.match(JSON.stringify(rows), /SYNTHETIC-PRIVATE-SUMMARY/u, "redaction preserves the stored event");
    await f.client.query("UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id=$2", [f.ids.space, f.ids.admin]);
    for (const result of await Promise.all(reads(f.ids.admin))) assert.match(JSON.stringify(result), /SYNTHETIC-PRIVATE-SUMMARY/u);
    await f.client.query(`UPDATE data.runs SET metadata_json=metadata_json||jsonb_build_object('machineId',$2::text)
      WHERE run_id=$1`, [f.ids.run, f.ids.machine]);
    const agent = { principal: { kind: "agent", id: f.ids.instance }, automationAgent: {
      ownerUserId: f.ids.owner, runId: f.ids.run, instanceId: f.ids.instance, channelId: f.ids.channel,
      machineId: f.ids.machine, executionKey: f.context.executionKey } };
    const agentReads = () => [
      automations.list({ requestId: crypto.randomUUID(), channelId: f.ids.channel, ...agent }),
      automations.get({ requestId: crypto.randomUUID(), automationId, ...agent }),
    ];
    for (const result of await Promise.all(agentReads())) assert.match(JSON.stringify(result), /SYNTHETIC-PRIVATE-SUMMARY/u);
    await f.client.query("UPDATE data.space_members SET role='participant' WHERE space_id=$1 AND user_id=$2", [f.ids.space, f.ids.owner]);
    for (const result of await Promise.all(agentReads())) {
      assert.match(JSON.stringify(result), /Synthetic audit/u);
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-PRIVATE-SUMMARY|private-event/u, "a live Agent follows its owner's current role");
    }
  } finally {
    await f.client.query("DELETE FROM data.automations WHERE automation_id=$1", [automationId]);
    for (const table of ["page_revisions", "page_access", "pages"]) {
      await f.client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [f.ids.space]);
    }
    await f.client.query("DELETE FROM control.scoped_control_command_replays WHERE scope_kind='space' AND scope_id=$1", [f.ids.space]);
    await f.client.query("DELETE FROM data.space_control_heads WHERE space_id=$1", [f.ids.space]);
    await database.close?.();
    await f.close();
  }
});
