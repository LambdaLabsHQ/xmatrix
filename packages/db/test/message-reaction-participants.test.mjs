import assert from "node:assert/strict";
import test from "node:test";

import {
  MessageAuthorityError,
  PostgresMessageRepository,
} from "../dist/message-control.js";
import { openMessageChannel, recordingDatabase, storedMessageRow } from "./recording-database.fixture.mjs";

const at = "2026-09-25T00:00:00.000Z";

function database(respond = () => []) {
  return recordingDatabase((query) => openMessageChannel(query)
    ?? (query.name?.startsWith("message_mutation_candidate_") ? [messageRow()] : respond(query)));
}

/** A message someone else wrote: the reactor is never its author. */
function messageRow() {
  return storedMessageRow(at);
}

function reaction(principal) {
  return {
    requestId: "reaction-test", spaceId: "space-1", channelId: "channel-1", messageId: "message-1",
    principal, commandId: "reaction-1", requestDigest: "5".repeat(64), expectedEntityVersion: 1,
    kind: "reaction", emoji: "👍", reactorLabel: principal.kind === "agent" ? "claude" : "Member",
  };
}

async function reactionWrite(principal) {
  const db = database();
  // Past the reaction row the finalizer may still refuse a fake row; only the
  // authorization and the relation row matter here.
  await new PostgresMessageRepository(db).mutateCollection(reaction(principal)).catch((error) => {
    if (error instanceof MessageAuthorityError && error.code === "forbidden") throw error;
  });
  return db.calls.find((query) => query.name === "message_reaction_upsert_v2");
}

test("a member who did not write the message may react to it", async () => {
  const upsert = await reactionWrite({ kind: "user", id: "member-1" });
  assert.ok(upsert, "the reaction row is written");
  assert.deepEqual(upsert.values.slice(3, 5), ["👍", "member-1"]);
  assert.equal(upsert.values[7], "user");
});

test("an Agent reacts under the identity its messages carry", async () => {
  const upsert = await reactionWrite({ kind: "agent", id: "channel-1:3" });
  assert.ok(upsert, "the Agent reaction row is written");
  assert.equal(upsert.values[4], "channel-1:3");
  assert.equal(upsert.values[7], "agent");
});

test("a non-author still cannot edit a message's attachments", async () => {
  const db = database();
  await assert.rejects(new PostgresMessageRepository(db).mutateCollection({
    ...reaction({ kind: "user", id: "member-1" }), kind: "attachment", action: "remove",
    attachmentId: "attachment-1",
  }), (error) => error instanceof MessageAuthorityError && error.code === "forbidden");
});

test("the mutation preflight keeps author access unless asked for participant access", async () => {
  const input = { requestId: "p", spaceId: "space-1", channelId: "channel-1", messageId: "message-1",
    principal: { kind: "user", id: "member-1" } };
  await assert.rejects(new PostgresMessageRepository(database()).mutationCandidate(input),
    (error) => error.code === "forbidden");
  const candidate = await new PostgresMessageRepository(database()).mutationCandidate({
    ...input, access: "participant",
  });
  assert.equal(candidate.messageId ?? candidate.message_id, "message-1");
});
