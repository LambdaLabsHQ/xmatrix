import assert from "node:assert/strict";
import test from "node:test";
import { recordingDatabase } from "../../db/test/recording-database.fixture.mjs";
import { postgresMessageAttachmentAuthorityRequest } from "../src/postgres-message-attachment-authority.ts";

const env = { RELAY_POSTGRES: { connectionString: "postgres://directory" },
  RELAY_POSTGRES_SHARD_ID: "shard-0" };
const input = { channelId: "c", messageId: "m", attachmentId: "a",
  principal: { kind: "user", id: "u" } };
const hash = "a".repeat(64);

function attachmentDatabase({ state = "active", failure, authorized = true } = {}) {
  return recordingDatabase((query) => {
    if (query.name === "space_placement_resolve_v1") throw new Error("Query read timeout");
    if (query.name === "channel_space_directory_resolve_placed_v1") {
      if (failure) throw failure;
      return [{ channel_id: "c", space_id: "s", shard_id: "shard-1",
        placement_epoch: 1, entity_version: 2,
        placement_space_id: "s", placement_shard_id: "shard-1",
        placement_placement_epoch: 3, placement_state: state,
        placement_target_shard_id: null, placement_plan_class: "shared" }];
    }
    if (query.name === "channel_capability_message_content_read_v3") {
      assert.deepEqual(query.values, ["c", "s", "user", "u"]);
      return authorized ? [{ channel_id: "c", space_id: "s", mode: "closed",
        metadata_json: {}, version: 1 }] : [];
    }
    if (query.name === "message_attachment_authority_v1") return [{
      source_channel_id: "c", source_mode: "closed", object_key: `objects/${hash}`,
      content_hash: hash, encoded_bytes: 12, mime_type: "text/plain", name: "note.txt",
      presentation_residual_json: null, version: 1 }];
    throw new Error(`Unexpected query: ${query.name}`);
  });
}

test("attachment authority reuses one session and current placement without a second directory read", async () => {
  const database = attachmentDatabase();
  const response = await postgresMessageAttachmentAuthorityRequest(env, input, { database });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).object.contentHash, hash);
  assert.deepEqual(database.calls.filter((call) => call.name).map((call) => call.name), [
    "channel_space_directory_resolve_placed_v1", "channel_capability_message_content_read_v3",
    "message_attachment_authority_v1",
  ]);
  assert.deepEqual(database.calls.filter((call) => call.context).at(-1).context.placement,
    { spaceId: "s", shardId: "shard-1", placementEpoch: 3 });
  assert.equal(database.sessionOpens, 1);
  assert.equal(database.sessionCloses, 1);
});

test("attachment routing fails closed during moves and when the user lacks capability", async () => {
  for (const options of [{ state: "moving" }, { state: "blocked" }, { authorized: false }]) {
    const database = attachmentDatabase(options);
    const response = await postgresMessageAttachmentAuthorityRequest(env, input, { database });
    assert.equal(response.status, options.authorized === false ? 404 : 503);
    assert.equal(database.calls.some((call) => call.name === "message_attachment_authority_v1"), false);
    assert.equal(database.sessionCloses, 1);
  }
});

test("an attachment directory timeout remains retryable and releases its failed session", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const failure = new Error("Query read timeout");
  const database = attachmentDatabase({ failure });
  const response = await postgresMessageAttachmentAuthorityRequest(env, input, { database });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).retryable, true);
  assert.equal(database.sessionCloses, 1);
  assert.equal(errors[0][1], failure, "the outage stays observable");
});
