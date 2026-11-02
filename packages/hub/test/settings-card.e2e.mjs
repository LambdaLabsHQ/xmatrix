import assert from "node:assert/strict";
import test from "node:test";
import { spaceSecretFixture } from "../../db/test/space-secret-postgres.fixture.mjs";
import { postgresMessageAppend } from "../src/postgres-message-authority.ts";
import { requestCardAppend } from "../src/secret-request-card.ts";
import { answerSettingsCard, readSettingsCard, settingsCardMetadata } from "../src/settings-card.ts";

/**
 * The card routes trust a card only as the Hub wrote it, read back from the
 * Channel's own history: who asked and since when must survive the real
 * message store, and a lookalike without the Hub's provenance must not.
 */
test("a settings card reads back from history as the Hub wrote it, and is answered once", async () => {
  const f = await spaceSecretFixture();
  const env = { RELAY_POSTGRES: { connectionString: process.env.XMATRIX_TEST_POSTGRES_URL }, RELAY_POSTGRES_SHARD_ID: "shard-0" };
  const append = (command) => postgresMessageAppend(env, f.ids.channel, command, { spaceId: f.ids.space });
  try {
    const asker = { userId: f.ids.owner, runId: f.ids.run, channelId: f.ids.channel, agentName: "claude", instanceId: f.ids.instance };
    const entries = [{ address: "secret:inventory" }, { address: "connector:appstoreconnect/vendorNumber", proposed: "87654321" }];
    const card = await requestCardAppend({ prefix: "settings-request", channelId: f.ids.channel, body: "claude asks",
      messageKind: "xmatrix.system.settings-request", label: "xMatrix settings request",
      owner: { id: f.ids.owner, email: "owner@example.test" }, appMetadata: settingsCardMetadata(asker, entries, { reason: "inventory" }) });
    const written = await append(card);
    const sequence = Number(written.sequence);
    const read = await readSettingsCard(env, { channelId: f.ids.channel, messageId: card.messageId, sequence, viewerUserId: f.ids.admin });
    assert.deepEqual(read?.entries, entries);
    assert.deepEqual(read?.asker, asker);
    assert.ok(Number.isFinite(Date.parse(read?.sentAt ?? "")));
    assert.equal(await readSettingsCard(env, { channelId: f.ids.channel, messageId: card.messageId, sequence: sequence + 1,
      viewerUserId: f.ids.admin }), undefined, "only the message at its own sequence");

    // The same metadata without the Hub's provenance is someone's lookalike.
    const lookalike = { ...card, messageId: "lookalike", commandId: "lookalike-append",
      residual: { appMetadata: settingsCardMetadata(asker, entries, {}) } };
    const forged = await append(lookalike);
    assert.equal(await readSettingsCard(env, { channelId: f.ids.channel, messageId: "lookalike", sequence: Number(forged.sequence),
      viewerUserId: f.ids.admin }), undefined);

    const satisfied = entries.map((entry) => ({ address: entry.address, satisfied: true }));
    assert.equal(await answerSettingsCard(env, read, [{ ...satisfied[0], satisfied: false }, satisfied[1]]), undefined);
    const answer = await answerSettingsCard(env, read, satisfied);
    assert.equal(answer, `settings-ready:${card.messageId}`);
    assert.equal(await answerSettingsCard(env, read, satisfied), answer, "a card read again is not answered again");
    const rows = (await f.client.query(`SELECT message_id, author_kind FROM data.messages WHERE space_id=$1 AND message_id=$2`,
      [f.ids.space, answer])).rows;
    assert.deepEqual(rows.map((row) => [row.message_id, row.author_kind]), [[answer, "system"]]);
  } finally {
    for (const table of ["idempotency_keys", "outbox", "message_mutations", "messages", "channel_content_counters",
      "message_sequence_reservations", "channel_message_sequences", "space_billing_usage", "space_storage_usage"]) {
      await f.client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [f.ids.space]);
    }
    await f.close();
  }
});
