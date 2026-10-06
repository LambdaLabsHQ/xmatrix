import { integration, isolatedPostgres, assertMigrationTooLarge } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const hash = (digit) => digit.repeat(64);
const attachment = (id, digit, overrides = {}) => ({ id, kind: "image", name: `${id}.png`, size: 120, version: 1,
  mimeType: "image/png", objectKey: `objects/${hash(digit)}`, contentHash: hash(digit), ...overrides });

integration("legacy attachments gain the ref product media reads, once, from their own message's facts", async () => {
  const migration = await readFile(new URL("../migrations/0161_expand_backfill_legacy_attachment_refs.sql",
    import.meta.url), "utf8");
  const schema = await readFile(new URL("../migrations/0027_expand_message_attachment_refs.sql", import.meta.url), "utf8");
  const isolated = await isolatedPostgres("legacy_attachment_refs", { migrate: false, runtimeRole: false });
  const { client } = isolated;
  try {
    await client.query(`CREATE SCHEMA data;
      CREATE TABLE data.messages (space_id text, channel_id text, message_id text, author_kind text, author_id text,
        sent_at timestamptz, deleted_at timestamptz, recalled_at timestamptz, attachments_json jsonb);`);
    await client.query(schema.slice(0, schema.indexOf("CREATE INDEX")));
    const insert = (id, author, attachments, extra = {}) => client.query(`INSERT INTO data.messages
      VALUES ('s','c',$1,$2,$3,'2026-08-01T00:00Z',$4,$5,$6::jsonb)`,
    [id, author[0], author[1], extra.deletedAt ?? null, extra.recalledAt ?? null, JSON.stringify(attachments)]);
    await insert("user-message", ["user", "owner"], [attachment("a1", "1"),
      attachment("a2", "2", { width: 640, height: 480 })]);
    await insert("agent-message", ["agent", "agent:owner:abc123"], [attachment("a3", "3")]);
    await insert("app-message", ["app", "github"], [attachment("a4", "4")]);
    await insert("refed-message", ["user", "owner"], [attachment("a5", "5")]);
    await insert("broken-message", ["user", "owner"], [attachment("a6", "6", { objectKey: "elsewhere/x" }),
      attachment("a7", "7", { channelId: "another" }), attachment("a8", "8", { size: 0 })]);
    await insert("deleted-message", ["user", "owner"], [attachment("a9", "9")], { deletedAt: "2026-08-02T00:00Z" });
    await client.query(`INSERT INTO data.message_attachment_refs VALUES ('s','a5','refed-message','c','kept',
      'objects/${hash("5")}','${hash("5")}',999,'image/png','kept.png',NULL,3,'2026-08-01T00:00Z','2026-08-01T00:00Z')`);
    for (let i = 0; i < 2; i++) {
      await client.query("BEGIN"); await client.query(migration); await client.query("COMMIT");
    }
    const refs = (await client.query(`SELECT attachment_id, message_id, owner_user_id, object_key, encoded_bytes,
        presentation_residual_json AS residual, version FROM data.message_attachment_refs ORDER BY attachment_id`)).rows;
    assert.deepEqual(refs.map(({ attachment_id, owner_user_id, encoded_bytes, residual, version }) =>
      [attachment_id, owner_user_id, Number(encoded_bytes), residual, Number(version)]), [
      ["a1", "owner", 120, null, 1],
      ["a2", "owner", 120, { width: 640, height: 480 }, 1],
      ["a3", "owner", 120, null, 1],
      ["a4", null, 120, null, 1],
      ["a5", "kept", 999, null, 3],
    ], "facts of the stored shape gain a ref; an existing ref, a malformed fact and a deleted message are left alone");
    assert.equal(refs.find((ref) => ref.attachment_id === "a1").object_key, `objects/${hash("1")}`);
    await client.query(`INSERT INTO data.messages SELECT 's','c','large-'||n,'user','owner','2026-08-01T00:00Z',NULL,NULL,
      jsonb_build_array(jsonb_build_object('id','x'||n)) FROM generate_series(1,100001) n`);
    await assertMigrationTooLarge(client, migration, `SELECT count(*)::int AS n FROM data.messages
      WHERE message_id LIKE 'large-%'`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await isolated.close();
  }
});
