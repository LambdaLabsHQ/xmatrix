import { integration, isolatedPostgres, assertMigrationTooLarge } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";


integration("channel activity backfill ranks old Channels by their latest kept message, once", async () => {
  const migration = await readFile(new URL("../migrations/0162_contract_backfill_channel_activity.sql",
    import.meta.url), "utf8");
  const isolated = await isolatedPostgres("channel_activity_backfill", { migrate: false, runtimeRole: false });
  const { client } = isolated;
  try {
    await client.query(`CREATE SCHEMA data;
      CREATE TABLE data.channels (space_id text,channel_id text,updated_at timestamptz,activity_at timestamptz,
        PRIMARY KEY (space_id,channel_id));
      CREATE TABLE data.messages (space_id text,channel_id text,sent_at timestamptz,deleted_at timestamptz);
      INSERT INTO data.channels VALUES
        ('s','quiet','2026-01-01T00:00Z',NULL),
        ('s','talked','2026-01-01T00:00Z',NULL),
        ('s','deleted-latest','2026-01-01T00:00Z',NULL),
        ('s','renamed-after','2026-03-01T00:00Z',NULL),
        ('s','kept','2026-01-01T00:00Z','2026-05-05T00:00Z');
      INSERT INTO data.messages VALUES
        ('s','talked','2026-02-01T00:00Z',NULL),('s','talked','2026-02-02T00:00Z',NULL),
        ('s','deleted-latest','2026-02-01T00:00Z',NULL),('s','deleted-latest','2026-02-09T00:00Z','2026-02-10T00:00Z'),
        ('s','renamed-after','2026-02-01T00:00Z',NULL),
        ('s','kept','2026-06-01T00:00Z',NULL);`);
    for (let i = 0; i < 2; i++) {
      await client.query("BEGIN"); await client.query(migration); await client.query("COMMIT");
    }
    const rows = (await client.query(`SELECT channel_id,to_char(activity_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day
      FROM data.channels ORDER BY channel_id`)).rows;
    assert.deepEqual(rows, [
      { channel_id: "deleted-latest", day: "2026-02-01" },
      { channel_id: "kept", day: "2026-05-05" },
      { channel_id: "quiet", day: "2026-01-01" },
      { channel_id: "renamed-after", day: "2026-03-01" },
      { channel_id: "talked", day: "2026-02-02" },
    ]);
    await client.query(`INSERT INTO data.channels SELECT 's','large:'||n,now(),NULL FROM generate_series(1,100001) n`);
    await assertMigrationTooLarge(client, migration,
      "SELECT count(*)::int AS n FROM data.channels WHERE activity_at IS NULL");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await isolated.close();
  }
});
