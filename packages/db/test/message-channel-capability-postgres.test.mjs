import { boundedPostgresTransaction as transaction } from "./postgres-database.fixture.mjs";
import { connectionString, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";

import { Client } from "pg";

import { requireChannelCapability } from "../dist/channel-capability-policy.js";
import { MessageAuthorityError } from "../dist/message-authority-error.js";



integration("active Message authorization shares lifecycle locks with writers and blocks archive", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const id = `message-lifecycle-${crypto.randomUUID()}`;
  const writer = new Client({ connectionString, application_name: `${id}-writer` });
  const archiver = new Client({ connectionString, application_name: `${id}-archiver` });
  await Promise.all([writer.connect(), archiver.connect()]);
  const scope = { spaceId: id, channelId: id, principal: { kind: "user", id } };

  try {
    await writer.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$1,'Lifecycle lock test',$1,1,'{}',now(),now())`, [id]);
    await writer.query(`INSERT INTO data.space_members
      (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$1,'owner',1,now(),now())`, [id]);
    await writer.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
       metadata_json,created_at,updated_at)
      VALUES ($1,$1,'Lifecycle lock test',$1,'open',$1,1,'{}',now(),now())`, [id]);

    await writer.query("BEGIN");
    await requireChannelCapability(transaction(writer), { ...scope,
      capability: "message_active_command", error: (failure) => new MessageAuthorityError(
        failure.code, failure.status, failure.message) });

    await archiver.query("SET lock_timeout = '250ms'");
    await assert.rejects(
      archiver.query("UPDATE data.channels SET archived_at=now() WHERE space_id=$1 AND channel_id=$1", [id]),
      (error) => error?.code === "55P03",
      "archive must wait for an admitted Message writer",
    );

    await writer.query("COMMIT");
    const archived = await archiver.query(
      "UPDATE data.channels SET archived_at=now() WHERE space_id=$1 AND channel_id=$1 RETURNING archived_at",
      [id],
    );
    assert.ok(archived.rows[0]?.archived_at);
  } finally {
    await writer.query("ROLLBACK").catch(() => {});
    await archiver.query("RESET lock_timeout").catch(() => {});
    for (const table of ["channels", "space_members", "spaces"]) {
      await writer.query(`DELETE FROM data.${table} WHERE space_id=$1`, [id]).catch(() => {});
    }
    await Promise.all([writer.end(), archiver.end()]);
  }
});

integration("concurrent appends queue on the Channel row instead of deadlocking on a lock upgrade", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const id = `message-append-lock-${crypto.randomUUID()}`;
  const first = new Client({ connectionString, application_name: `${id}-first` });
  const second = new Client({ connectionString, application_name: `${id}-second` });
  await Promise.all([first.connect(), second.connect()]);
  const scope = { spaceId: id, channelId: id, principal: { kind: "user", id },
    error: (failure) => new MessageAuthorityError(failure.code, failure.status, failure.message) };

  try {
    await first.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$1,'Append lock test',$1,1,'{}',now(),now())`, [id]);
    await first.query(`INSERT INTO data.space_members
      (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$1,'owner',1,now(),now())`, [id]);
    await first.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
       metadata_json,created_at,updated_at)
      VALUES ($1,$1,'Append lock test',$1,'open',$1,1,'{}',now(),now())`, [id]);

    // A share lock here let a second append in behind the first; each then had
    // to wait out the other's share to advance activity_at, and PostgreSQL
    // refused one of them as a deadlock (40P01).
    await first.query("BEGIN");
    await requireChannelCapability(transaction(first), { ...scope, capability: "message_append" });
    await second.query("BEGIN");
    await second.query("SET LOCAL lock_timeout = '250ms'");
    await assert.rejects(
      requireChannelCapability(transaction(second), { ...scope, capability: "message_append" }),
      (error) => error?.code === "55P03",
      "a second append must queue behind the first on the Channel row",
    );
    await second.query("ROLLBACK");

    await first.query("SET LOCAL lock_timeout = '250ms'");
    await first.query(
      "UPDATE data.channels SET activity_at=now() WHERE space_id=$1 AND channel_id=$1", [id]);
    await first.query("COMMIT");

    await second.query("BEGIN");
    await requireChannelCapability(transaction(second), { ...scope, capability: "message_append" });
    await second.query("COMMIT");
  } finally {
    await first.query("ROLLBACK").catch(() => {});
    await second.query("ROLLBACK").catch(() => {});
    for (const table of ["channels", "space_members", "spaces"]) {
      await first.query(`DELETE FROM data.${table} WHERE space_id=$1`, [id]).catch(() => {});
    }
    await Promise.all([first.end(), second.end()]);
  }
});
