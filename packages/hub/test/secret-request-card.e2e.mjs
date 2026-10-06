import assert from "node:assert/strict";
import test from "node:test";
import { spaceSecretFixture } from "../../db/test/space-secret-postgres.fixture.mjs";
import { postgresMessageAppend } from "../src/postgres-message-authority.ts";
import { secretRequestAppend } from "../src/secret-request-card.ts";

test("saved inventory requests append and replay in PostgreSQL without granting the Run access", async () => {
  const f = await spaceSecretFixture();
  const env = { RELAY_POSTGRES: { connectionString: process.env.XMATRIX_TEST_POSTGRES_URL },
    RELAY_POSTGRES_SHARD_ID: "shard-0" };
  const card = { secretRef: "inventory", envName: "INVENTORY_TOKEN", runId: f.ids.run,
    channelId: f.ids.channel, agentName: "codex", reason: "Read namespace metadata" };
  const owner = { id: f.ids.owner, email: "owner@example.test" };
  const append = command => postgresMessageAppend(env, f.ids.channel, command, { spaceId: f.ids.space });
  try {
    const missing = await secretRequestAppend(card, false, owner);
    const first = await append(missing);
    assert.deepEqual(await append(missing), first);
    await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef: card.secretRef,
      envName: card.envName, value: "test-inventory-value", access: "ask" });
    const saved = await secretRequestAppend(card, true, owner);
    // This was the production failure: a new body with the old immutable append key.
    await assert.rejects(append({ ...saved, messageId: missing.messageId, commandId: missing.commandId }),
      error => error.code === "idempotency_conflict" || error.code === "IDEMPOTENCY_CONFLICT");
    const second = await append(saved);
    assert.deepEqual(await append(saved), second);
    const rows = (await f.client.query("SELECT message_id FROM data.messages WHERE space_id=$1 ORDER BY timeline_sequence",
      [f.ids.space])).rows;
    assert.deepEqual(rows.map(row => row.message_id), [missing.messageId, saved.messageId]);
    await assert.rejects(f.secret.runRead(f.run, [card.secretRef]), error => error.code === "secret_approval_required");
    await assert.rejects(f.secret.approve({ userId: f.ids.owner, runId: f.ids.run, channelId: f.ids.channel,
      secretRef: card.secretRef }), error => error.code === "forbidden");
    assert.equal((await f.secret.approve({ userId: f.ids.admin, runId: f.ids.run, channelId: f.ids.channel,
      secretRef: card.secretRef })).readable, true);
  } finally {
    for (const table of ["idempotency_keys", "outbox", "message_mutations", "messages", "channel_content_counters",
      "message_sequence_reservations", "channel_message_sequences", "space_billing_usage", "space_storage_usage"]) {
      await f.client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [f.ids.space]);
    }
    await f.close();
  }
});
