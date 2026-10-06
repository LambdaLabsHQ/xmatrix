import assert from "node:assert/strict";
import test from "node:test";
import { PostgresRegistrationLaunchRepository } from "../dist/agent-registration-launch.js";

const source = { spaceId: "space", ownerUserId: "owner", machineId: "machine-a", harness: "codex" };
const input = { commandId: "handoff", actorUserId: "owner", channelId: "channel", body: "continue",
  excludeSourceInstanceId: "source-instance" };

function fixture({ missing = false, prior, bindingHarness = source.harness, keys = [source,
  { ...source, harness: "claude_code" }, { ...source, machineId: "machine-b" }] } = {}) {
  const database = { cacheMode: "disabled", async transaction(_context, callback) {
    return callback({ async query(statement) {
      if (statement.name === "registration_launch_excluded_source_v1") {
        assert.deepEqual(statement.values, ["source-instance", "channel", "space", "owner"]);
        return missing ? [] : [{ space_id: source.spaceId, owner_user_id: source.ownerUserId,
          machine_id: source.machineId, harness: bindingHarness }];
      }
      assert.equal(statement.name, "registration_launch_input_existing_v1");
      return prior ? [{ state: "prepared", launch_request_json: prior }] : [];
    } });
  } };
  const repo = new PostgresRegistrationLaunchRepository(database, database,
    { spaceId: "space", shardId: "test", placementEpoch: 1 });
  repo.candidatesFor = async () => ({
    offered: keys.map(key => ({ key, models: ["model"], workspaces: [], workspaceReferences: [] })),
    blocked: [], offlineOnly: false,
  });
  repo.prepare = async request => request;
  repo.withHost = async (_commandId, prepared) => prepared;
  return repo;
}

test("handoff excludes the stable source Agent despite a refreshed quota reading", async () => {
  const repo = fixture();
  for (const successorIndex of [0, 1]) {
    const result = await repo.dispatchInput(input, async ({ candidates }) => {
      assert.deepEqual(candidates.map(candidate => candidate.key), [
        { ...source, harness: "claude_code" }, { ...source, machineId: "machine-b" },
      ]);
      return { key: candidates[successorIndex].key, model: "model" };
    });
    assert.notDeepEqual(result.key, source);
  }
});

test("a chooser cannot return the excluded source; no alternative fails closed", async () => {
  await assert.rejects(fixture().dispatchInput(input, async () => ({ key: source, model: "model" })),
    error => error.code === "registration_selection_invalid");
  await assert.rejects(fixture({ keys: [source] }).dispatchInput(input, async () => assert.fail("no candidate")),
    error => error.code === "registration_not_found");
});

test("a legacy harness alias in the source binding cannot evade identity exclusion", async () => {
  const canonical = { ...source, harness: "claude" };
  const other = { ...canonical, machineId: "machine-b" };
  const repo = fixture({ bindingHarness: "claude_code", keys: [canonical, other] });
  await repo.dispatchInput(input, async ({ candidates }) => {
    assert.deepEqual(candidates.map(candidate => candidate.key), [other]);
    return { key: other, model: "model" };
  });
  await assert.rejects(fixture({ bindingHarness: "claude_code", prior: { key: canonical } })
    .dispatchInput(input, async () => assert.fail("alias replay")), error => error.code === "handoff_same_agent");
});

test("unknown or unauthorized predecessor and replay to the source cannot launch", async () => {
  await assert.rejects(fixture({ missing: true }).dispatchInput(input, async () => assert.fail("missing source")),
    error => error.code === "instance_not_found");
  await assert.rejects(fixture({ prior: { key: source } }).dispatchInput(input, async () => assert.fail("replay")),
    error => error.code === "handoff_same_agent");
  const other = { ...source, machineId: "machine-b" };
  assert.deepEqual((await fixture({ prior: { key: other } }).dispatchInput(input,
    async () => assert.fail("a valid replay must not choose again"))).key, other);
});
