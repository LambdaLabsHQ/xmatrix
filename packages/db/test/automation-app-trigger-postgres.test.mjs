import { integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { createAuthorityDatabase, PostgresAutomationRepository, PostgresPageRepository } from "../dist/index.js";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";

// A connected app's event carries the Space's private content (a Slack
// message, a pull request), so it reaches a page Automation only while the
// Automation's authority may use the Space's connected apps: an author who
// became a participant keeps the Automation, but no new event is written
// into it, where they could read it, nor wakes it.
integration("connected-app events skip an Automation whose author can no longer use the Space's apps", async () => {
  const fixture = await spaceSecretFixture();
  const { ids, client } = fixture;
  const database = createAuthorityDatabase({ connectionString: process.env.XMATRIX_TEST_POSTGRES_URL, shardId: "shard-0",
    applicationName: "automation-app-trigger", statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000 });
  const automationId = crypto.randomUUID();
  try {
    await client.query("INSERT INTO data.space_control_heads (space_id,commit_sequence,updated_at) VALUES ($1,0,now())",
      [ids.space]);
    const { page } = await new PostgresPageRepository(database).create({ requestId: crypto.randomUUID(), spaceId: ids.space,
      principal: { kind: "user", id: ids.owner }, title: "Watch Slack",
      body: `[Slack watch](xmatrix:automation/${automationId})` });
    await client.query(`INSERT INTO data.automations (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,
      payload_json,page_id,created_at,updated_at) VALUES ($1,$2,$3,now()+interval '1 day',true,1,$4::jsonb,$5,now(),now())`,
    [automationId, ids.owner, ids.channel, JSON.stringify({ name: "Slack watch", intervalMinutes: 60,
      message: { body: "@auto summarize" }, triggers: [{ kind: "event", provider: "slack", source: "*" }] }), page.pageId]);
    const automations = new PostgresAutomationRepository(database);
    const candidates = async () => (await automations.triggeredBy({ requestId: crypto.randomUUID(),
      trigger: { kind: "event", provider: "slack" }, spaceId: ids.space, appUse: true })).map((row) => row.automationId);
    const fire = (eventId) => automations.fireTrigger({ requestId: crypto.randomUUID(), automationId, eventId,
      event: { kind: "event", summary: `event ${eventId}` }, at: new Date().toISOString(), appUse: true });
    const events = async () => (await client.query("SELECT trigger_events FROM data.automations WHERE automation_id=$1",
      [automationId])).rows[0].trigger_events ?? [];

    assert.deepEqual(await candidates(), [automationId]);
    assert.equal(await fire("member-event"), ids.channel);
    await client.query("UPDATE data.space_members SET role='participant' WHERE space_id=$1 AND user_id=$2",
      [ids.space, ids.owner]);
    assert.deepEqual(await candidates(), []);
    assert.equal(await fire("participant-event"), null, "the final write rechecks under the Automation's lock");
    assert.deepEqual((await events()).map((event) => event.id), ["member-event"]);
  } finally {
    await client.query("DELETE FROM data.automations WHERE automation_id=$1", [automationId]);
    for (const table of ["page_revisions", "page_access", "pages"]) {
      await client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [ids.space]);
    }
    await client.query("DELETE FROM control.scoped_control_command_replays WHERE scope_kind='space' AND scope_id=$1",
      [ids.space]);
    await client.query("DELETE FROM data.space_control_heads WHERE space_id=$1", [ids.space]);
    await database.close?.();
    await fixture.close();
  }
});
