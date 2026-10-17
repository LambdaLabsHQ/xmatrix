import assert from "node:assert/strict";
import test from "node:test";
import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import { PostgresRegistrationLaunchRepository } from "../dist/agent-registration-launch.js";

const placement = { spaceId: "space", shardId: "test", placementEpoch: 1 };
const failed = { spaceId: "space", ownerUserId: "member", machineId: "mac", harness: "grok" };

/** A committed `registration-launch` intent for run-1, from `messageId` with `body`. */
async function fixture({ body, messageId = "message-1", author = { kind: "user", id: "actor" }, origin = true }) {
  const bodyHash = await digestCanonicalCloneCborV1(body);
  const reads = [];
  const database = { cacheMode: "disabled", async transaction(_context, callback) {
    return callback({ async query(statement) {
      if (statement.name === "registration_launch_fallback_origin_v1") {
        assert.deepEqual(statement.values, ["run-1", "channel", "space"]);
        assert.match(statement.text, /command_id LIKE 'registration-launch%'/u);
        return origin ? [{ actor_user_id: "actor", source_message_id: messageId, selection_index: 0,
          owner_user_id: failed.ownerUserId, machine_id: failed.machineId, harness: failed.harness, timeline_sequence: "7" }] : [];
      }
      if (statement.name === "channel_capability_runtime_new_work_v3") return [{ channel_id: "channel", space_id: "space",
        mode: "conversation", metadata_json: {}, version: 1 }];
      if (statement.name === "message_invocation_selections_source_v1") return [{ author_kind: author.kind,
        author_id: author.id, timeline_sequence: 7, body_hash: bodyHash, input_version: 1, agent_invocation_targets_json: null }];
      if (statement.name === "message_invocation_first_message_summon_v1") return [{ present: 1 }];
      throw new Error(`Unexpected query ${statement.name}`);
    } });
  } };
  const repository = new PostgresRegistrationLaunchRepository(database, database, placement);
  const origin_ = () => repository.startupFallbackOrigin({ commandId: "startup-fallback:run-1", channelId: "channel",
    runId: "run-1", readBody: async (actorUserId, sequence) => { reads.push([actorUserId, sequence]); return body; } });
  return { origin: origin_, reads };
}

test("an @auto summon that failed to start is retried from its message, with its author's conditions", async () => {
  const body = "@auto repo:acme/app launch:force fix the login page";
  const { origin, reads } = await fixture({ body });
  const found = await origin();
  assert.deepEqual(reads, [["actor", 7]]);
  assert.deepEqual(found, { actorUserId: "actor", sourceMessageId: "message-1", body,
    sourceMention: "@auto repo:acme/app launch:force", tags: { repo: "acme/app" }, failed });
});

test("xMatrix's summon for a first message that named nobody is retried on any Agent", async () => {
  const body = "@grok launch:force";
  const { origin } = await fixture({ body, messageId: "xmatrix-summon:first", author: { kind: "system", id: "xmatrix" } });
  const found = await origin();
  assert.equal(found.sourceMessageId, "xmatrix-summon:first");
  assert.deepEqual(found.tags, {});
});

test("an Agent the author named, and a launch with no message origin, are never handed to another", async () => {
  assert.equal(await (await fixture({ body: "@grok fix the login page" })).origin(), undefined);
  assert.equal(await (await fixture({ body: "@auto fix it", origin: false })).origin(), undefined);
});

test("the retry excludes the environment that failed, whoever owns it", async () => {
  const other = { ...failed, harness: "claude" };
  const database = { cacheMode: "disabled", async transaction(_context, callback) {
    return callback({ async query(statement) {
      assert.equal(statement.name, "registration_launch_input_existing_v1");
      return [];
    } });
  } };
  const repository = new PostgresRegistrationLaunchRepository(database, database, placement);
  repository.candidatesFor = async () => ({ offered: [failed, other].map(key => ({ key, models: ["model"],
    workspaces: [], workspaceReferences: [] })), blocked: [], offlineOnly: false });
  repository.prepare = async request => request;
  repository.withHost = async (_commandId, prepared) => prepared;
  const input = { commandId: "startup-fallback:run-1", actorUserId: "actor", channelId: "channel", body: "@auto fix it",
    excludeRegistration: failed };
  const result = await repository.dispatchInput(input, async ({ candidates }) => {
    assert.deepEqual(candidates.map(candidate => candidate.key), [other]);
    return { key: other, model: "model" };
  });
  assert.deepEqual(result.key, other);
  repository.candidatesFor = async () => ({ offered: [{ key: failed, models: ["model"], workspaces: [], workspaceReferences: [] }],
    blocked: [], offlineOnly: false });
  await assert.rejects(repository.dispatchInput(input, async () => assert.fail("nothing else can take it")),
    error => error.code === "registration_not_found");
});
