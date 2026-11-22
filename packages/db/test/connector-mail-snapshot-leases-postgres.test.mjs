import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createAuthorityDatabase,
  MAIL_SNAPSHOT_KEY_PREFIX,
  PostgresMailSnapshotLeaseRepository,
} from "../dist/index.js";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

const keyFor = (ch) => `${MAIL_SNAPSHOT_KEY_PREFIX}${ch.repeat(43)}`;

integration("mail snapshot leases enforce exact snapshot keys, retry backoff, bounded keyset paging, and idempotent deletion", async () => {
  const f = await isolatedPostgres("mail_snapshot_leases", { shard: true });
  const db = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
  const repo = new PostgresMailSnapshotLeaseRepository(db);
  try {
    const baseMs = Date.parse("2026-11-23T00:00:00.000Z");
    const iso = (offsetMs) => new Date(baseMs + offsetMs).toISOString();

    for (const badKey of ["objects/abc", `${MAIL_SNAPSHOT_KEY_PREFIX}short`, `${MAIL_SNAPSHOT_KEY_PREFIX}../escape`]) {
      await assert.rejects(
        repo.reserve({ requestId: randomUUID(), objectKey: badKey, commandId: "cmd-bad", expiresAt: iso(600_000) }),
        { code: "invalid_app_request" },
      );
    }

    const keyA = keyFor("a");
    const keyB = keyFor("b");
    const keyC = keyFor("c");
    const reservedA = await repo.reserve({ requestId: randomUUID(), objectKey: keyA, commandId: "approval:1", expiresAt: iso(600_000) });
    assert.equal(reservedA.state, "staged");
    assert.equal(reservedA.attempts, 0);
    assert.equal(reservedA.expiresAt, iso(600_000));
    assert.equal(reservedA.nextAttemptAt, iso(600_000));

    await repo.reserve({ requestId: randomUUID(), objectKey: keyB, commandId: "approval:2", expiresAt: iso(600_000) });
    await repo.reserve({ requestId: randomUUID(), objectKey: keyC, commandId: "approval:3", expiresAt: iso(1_200_000) });

    // Before expiry, nothing is due.
    assert.deepEqual(await repo.due({ requestId: randomUUID(), now: iso(300_000) }), []);

    // Failed delete transitions keyB to delete_pending with bounded exponential backoff.
    const retry1 = await repo.markDeleteFailed({ requestId: randomUUID(), objectKey: keyB, baseDelayMs: 15_000, now: iso(10_000) });
    assert.equal(retry1.state, "delete_pending");
    assert.equal(retry1.attempts, 1);
    assert.equal(retry1.nextAttemptAt, iso(25_000));

    // Retry is due once backoff elapses, even before original expiry.
    const dueRetry = await repo.due({ requestId: randomUUID(), now: iso(30_000) });
    assert.deepEqual(dueRetry.map((row) => row.objectKey), [keyB]);

    // Second failure doubles backoff (30s).
    const retry2 = await repo.markDeleteFailed({ requestId: randomUUID(), objectKey: keyB, baseDelayMs: 15_000, now: iso(30_000) });
    assert.equal(retry2.attempts, 2);
    assert.equal(retry2.nextAttemptAt, iso(60_000));

    // At 600s, both keyA (expired staged) and keyB (delete_pending) are due, paginated cleanly by exact keyset cursor.
    const page1 = await repo.due({ requestId: randomUUID(), limit: 1, now: iso(600_000) });
    assert.deepEqual(page1.map((row) => row.objectKey), [keyA]);
    const page2 = await repo.due({ requestId: randomUUID(), limit: 1, afterObjectKey: page1[0].objectKey, now: iso(600_000) });
    assert.deepEqual(page2.map((row) => row.objectKey), [keyB]);
    const page3 = await repo.due({ requestId: randomUUID(), limit: 1, afterObjectKey: page2[0].objectKey, now: iso(600_000) });
    assert.deepEqual(page3, []);

    // Idempotent concurrent deletion.
    assert.equal(await repo.markDeleted({ requestId: randomUUID(), objectKey: keyA }), true);
    assert.equal(await repo.markDeleted({ requestId: randomUUID(), objectKey: keyA }), false);
    assert.equal(await repo.markDeleted({ requestId: randomUUID(), objectKey: keyB }), true);
    assert.equal(await repo.markDeleteFailed({ requestId: randomUUID(), objectKey: keyB, now: iso(700_000) }), null);

    // keyC becomes due at 1200s.
    const later = await repo.due({ requestId: randomUUID(), now: iso(1_200_000) });
    assert.deepEqual(later.map((row) => row.objectKey), [keyC]);
  } finally {
    await f.close();
  }
});
