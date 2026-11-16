import assert from "node:assert/strict";
import { connectionString, integration, seedMessageSpace, integrationAuthority } from "./postgres-database.fixture.mjs";

import { Client } from "pg";

import { databaseFailureEvidence, DatabaseCommitUnknownError, PostgresMessageRepository } from "../dist/index.js";
import { recoveringDatabase } from "./response-fault-postgres.fixture.mjs";

/**
 * The Hub records its own judgment about a message as `system`, never as the
 * author, and without touching what the message invoked
 * (command results, questionnaire states).
 */

const now = "2026-09-27T00:00:00.000Z";
const SPACE = "space-system-annotation";
const DIGEST = "a".repeat(64);

async function seed() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await seedMessageSpace(client, { space: SPACE, channel: "conversation", at: now,
      tables: ["data.outbox", "data.message_mutations", "data.idempotency_keys",
      "data.message_annotations", "data.messages", "data.channels", "data.spaces"] });
    for (const [messageId, sequence, recalled] of [["status", 1, false], ["recalled", 2, true]]) {
      await client.query(`INSERT INTO data.messages
        (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
         message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,
         legacy_body,created_at,recalled_at,invocation_input_version)
        VALUES ($1,'conversation',$2,$3,1,'agent','agent-1','xmatrix.message.text','hash','inline',
          'inline',$4,$4,$2,'Progress: running tests',$4,$5,1)`,
        [SPACE, messageId, sequence, now, recalled ? now : null]);
    }
  } finally {
    await client.end();
  }
}

integration("a system annotation is the Hub's, idempotent, and leaves the invocation alone", async () => {
  await seed();
  const database = integrationAuthority();
  const repository = new PostgresMessageRepository(database);
  const judgment = {
    requestId: "judge", spaceId: SPACE, channelId: "conversation", messageId: "status",
    namespace: "xmatrix.command-result", annotationId: "xmatrix.command-result:status",
    payload: { note: "later" }, requestDigest: DIGEST,
  };
  const annotation = await repository.annotateAsSystem(judgment);
  assert.equal(annotation.authorUserId, "system:xmatrix");
  assert.deepEqual(annotation.payload, { note: "later" });
  assert.equal(await repository.annotateAsSystem({ ...judgment, requestId: "again" }), null,
    "the same judgment twice records nothing new");
  assert.equal(await repository.annotateAsSystem({ ...judgment, messageId: "recalled",
    annotationId: "xmatrix.command-result:recalled" }), null, "a recalled message is left alone");
  await assert.rejects(repository.annotateAsSystem({ ...judgment, namespace: "memory" }),
    /reserved namespace/u);

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const [row] = (await client.query(`SELECT entity_version,invocation_input_version,annotations_json
      FROM data.messages WHERE space_id=$1 AND message_id='status'`, [SPACE])).rows;
    assert.equal(Number(row.entity_version), 2);
    assert.equal(Number(row.invocation_input_version), 1);
    assert.equal(row.annotations_json.length, 1);
    const ledger = (await client.query(`SELECT actor_kind,actor_id,mutation_kind FROM data.message_mutations
      WHERE space_id=$1 AND message_id='status'`, [SPACE])).rows;
    assert.deepEqual(ledger, [{ actor_kind: "system", actor_id: "xmatrix", mutation_kind: "annotation" }]);
    const stored = (await client.query(`SELECT author_user_id,namespace FROM data.message_annotations
      WHERE space_id=$1`, [SPACE])).rows;
    assert.deepEqual(stored, [{ author_user_id: "system:xmatrix", namespace: "xmatrix.command-result" }]);
  } finally {
    await client.end();
  }
});

// HUB-BV lost the outbox response after all annotation writes. Healthy
// idempotence tests cannot catch a missing fresh-session replay or partial facts.
integration("system judgments recover one pre-COMMIT loss and recheck the message (HUB-BV)", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const scenario of ["recover", "recall", "twice", "answered", "commit"]) {
      await seed();
      const failure = scenario === "answered"
        ? Object.assign(new Error("database rejection"), { code: "57014" }) : new Error("Query read timeout");
      const fault = { matches: scenario === "commit" ? /^COMMIT$/u : /INSERT INTO data\.outbox/u,
        remaining: scenario === "twice" ? 2 : 1, error: failure, checkouts: [],
        ...(scenario === "twice" ? { errors: [new Error("Query read timeout"), failure] } : {}),
        ...(scenario === "recall" ? { afterClose: () => client.query(
          "UPDATE data.messages SET recalled_at=now() WHERE space_id=$1 AND message_id='status'", [SPACE]) } : {}) };
      const { database, clients } = recoveringDatabase(() => fault);
      const session = database.openSession();
      // Hub callers can already own a request session; recovery must still
      // acquire a new session instead of reviving the abandoned transaction.
      const repository = new PostgresMessageRepository(session, true);
      const input = { requestId: scenario, spaceId: SPACE, channelId: "conversation", messageId: "status",
        namespace: "xmatrix.command-result", annotationId: "xmatrix.command-result:status",
        payload: { note: "Machine stopped" }, requestDigest: DIGEST };
      try {
        if (scenario === "recover" || scenario === "recall") {
          const result = await repository.annotateAsSystem(input);
          assert.equal(result?.authorUserId ?? null, scenario === "recall" ? null : "system:xmatrix");
          assert.equal(await repository.annotateAsSystem(input), null, "same judgment stays idempotent");
        } else {
          await assert.rejects(repository.annotateAsSystem(input), error => {
            if (scenario === "commit") assert.ok(error instanceof DatabaseCommitUnknownError);
            else assert.equal(error, failure);
            if (scenario === "twice") assert.equal(databaseFailureEvidence(error).length, 2);
            return true;
          });
        }
      } finally { await session.close(); }
      assert.equal(fault.checkouts.length, scenario === "twice" ? 2 : 1);
      assert.ok(clients.every(entry => entry.ended), "all owned sessions close");
      for (const abandoned of fault.checkouts) {
        assert.equal(abandoned.queries.includes("COMMIT"), scenario === "commit");
        assert.equal(abandoned.queries.includes("ROLLBACK"), scenario === "answered",
          "a lost response destroys its checkout without queueing ROLLBACK");
      }
      const mutations = Number(scenario === "recover" || scenario === "commit");
      const [row] = (await client.query(`SELECT entity_version,invocation_input_version,annotations_json
        FROM data.messages WHERE space_id=$1 AND message_id='status'`, [SPACE])).rows;
      assert.equal(Number(row.entity_version), 1 + mutations);
      assert.equal(Number(row.invocation_input_version), 1);
      assert.equal(row.annotations_json.length, mutations);
      for (const table of ["message_annotations", "message_mutations", "outbox", "idempotency_keys"]) {
        assert.equal(Number((await client.query(`SELECT count(*) FROM data.${table} WHERE space_id=$1`, [SPACE])).rows[0].count),
          mutations, `${scenario}: ${table} is atomic and written once`);
      }
    }
  } finally { await client.end(); }
});
