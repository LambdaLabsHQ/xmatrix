import assert from "node:assert/strict";
import test from "node:test";

import { DatabaseContractError } from "../dist/errors.js";
import { loadChannelAgentPresence, loadVisibleLiveAgentPresence } from "../dist/channel-agent-presence.js";

function row(overrides = {}) {
  return {
    instance_id: "instance-1",
    channel_id: "channel-1",
    channel_instance_id: 6,
    status: "online",
    created_at: "2026-09-05T00:00:00.000Z",
    updated_at: "2026-09-05T00:01:00.000Z",
    workspace_machine_id: "machine-workspace",
    workspace_canonical_cwd: "/workspace",
    run_metadata_json: { machineId: "machine-runtime", hostId: "host-1" },
    agent_name: "Codex",
    owner_email: "owner@example.test",
    registration_owner: "owner-1",
    registration_machine: "machine-1",
    registration_harness: "codex",
    ...overrides,
  };
}

test("PostgreSQL Channel Presence keys each registered Run by its Instance", async () => {
  let query;
  const transaction = {
    async query(input) {
      if (input.name === "channel_agent_resting_presence_v4") return [];
      query = input;
      return [
        row({ run_metadata_json: { machineId: "machine-runtime", hostname: "current-computer" } }),
        row({
          instance_id: "instance-2", channel_instance_id: "7", status: "busy",
          created_at: "2026-09-05T00:02:00.000Z",
          updated_at: "2026-09-05T00:03:00.000Z",
        }),
      ];
    },
  };
  const result = await loadChannelAgentPresence(
    transaction, "space-1", ["channel-1", "channel-1"],
  );
  const presence = result.get("channel-1");
  assert.deepEqual(Object.keys(presence).sort(), ["instance-1", "instance-2"]);
  assert.equal(presence["instance-2"].kind, "agent");
  assert.equal(presence["instance-2"].lastSeenAt, "2026-09-05T00:03:00.000Z");
  assert.deepEqual(presence["instance-1"].instances.map((instance) => ({
    id: instance.id,
    channelInstanceId: instance.channelInstanceId,
    label: instance.label,
    status: instance.status,
  })), [{ id: "instance-1", channelInstanceId: "6", label: "Codex:6", status: "online" }]);
  assert.equal(presence["instance-1"].instances[0].machineId, "machine-runtime");
  assert.equal(presence["instance-1"].instances[0].hostname, "current-computer");
  assert.equal(presence["instance-1"].instances[0].hostId, "current-computer");
  assert.equal(presence["instance-2"].instances[0].hostId, "host-1", "supported legacy metadata is observation only");
  assert.equal(presence["instance-1"].instances[0].cwd, "/workspace");
  // The member carries its registration, the identity clients read.
  assert.deepEqual(presence["instance-1"].registration,
    { ownerUserId: "owner-1", machineId: "machine-1", harness: "codex" });
  assert.deepEqual(query.values, ["space-1", ["channel-1"]]);
  assert.equal(query.maxRows, 513);
  assert.match(query.text, /JOIN data\.run_agent_registrations b/u);
  assert.doesNotMatch(query.text, /agent_profile/u);
  assert.match(query.text, /i\.status IN \('online','busy','idle'\)/u);
  assert.match(query.text, /r\.status IN \('running','stopping'\)/u);
  assert.match(query.text, /management_channel_about/u);
  assert.match(query.text, /LIMIT 513/u);
});

test("a management delegate Instance wears the xMatrix persona on its Instance label only", async () => {
  const transaction = {
    async query(input) {
      if (input.name === "channel_agent_resting_presence_v4") return [];
      return [row({
        run_metadata_json: { routedAs: "management_assistant_mention", managementSpaceId: "space-1" },
      })];
    },
  };
  const result = await loadChannelAgentPresence(transaction, "space-1", ["channel-1"]);
  const presence = result.get("channel-1")["instance-1"];
  assert.equal(presence.label, "Codex");
  assert.deepEqual(presence.instances.map((instance) => instance.label), ["xMatrix:6"]);
});

test("PostgreSQL Channel Presence fails closed instead of truncating active Instances", async () => {
  const transaction = { async query() { return Array.from({ length: 513 }, (_, index) => row({
    instance_id: `instance-${index}`,
    channel_instance_id: index + 1,
  })); } };
  await assert.rejects(
    loadChannelAgentPresence(transaction, "space-1", ["channel-1"]),
    (error) => error instanceof DatabaseContractError &&
      error.message === "Active Agent Instance presence limit exceeded",
  );
});

test("a resting Instance stays in its Channel's Presence as offline with its rest", async () => {
  const queries = [];
  const transaction = {
    async query(input) {
      queries.push(input);
      if (input.name === "channel_agent_presence_v8") return [row()];
      return [
        row({ instance_id: "instance-2", channel_instance_id: 7, status: "offline", rest_state: "sleeping",
          waking: false }),
        row({ instance_id: "instance-3", channel_instance_id: 8, status: "offline", rest_state: "interrupted",
          waking: false }),
        row({ instance_id: "instance-4", channel_instance_id: 9, status: "offline", rest_state: "sleeping",
          waking: true }),
        // A failed wake's successor Run may still read `starting`: the failure wins.
        row({ instance_id: "instance-5", channel_instance_id: 10, status: "offline", rest_state: "wake_failed",
          rest_reason: "reborn_spawn_failed: slot reclaimed", waking: true }),
      ];
    },
  };
  const presence = (await loadChannelAgentPresence(transaction, "space-1", ["channel-1"])).get("channel-1");
  assert.deepEqual(Object.keys(presence).sort(), ["instance-1", "instance-2", "instance-3", "instance-4", "instance-5"]);
  assert.deepEqual(presence["instance-1"].instances[0].rest, undefined);
  assert.deepEqual(["instance-2", "instance-3", "instance-4", "instance-5"].map((id) => ({
    status: presence[id].instances[0].status, rest: presence[id].instances[0].rest,
    restReason: presence[id].instances[0].restReason,
  })), [
    { status: "offline", rest: "sleeping", restReason: undefined },
    { status: "offline", rest: "interrupted", restReason: undefined },
    { status: "offline", rest: "waking", restReason: undefined },
    { status: "offline", rest: "wake_failed", restReason: "reborn_spawn_failed: slot reclaimed" },
  ]);
  const resting = queries.find((query) => query.name === "channel_agent_resting_presence_v4");
  // Bounded per Channel, newest first, and never a stopped or live Instance.
  assert.deepEqual(resting.values, ["space-1", ["channel-1"], 12]);
  assert.match(resting.text, /i\.status='offline'/u);
  assert.match(resting.text, /i\.rest_state IN \('sleeping','interrupted','wake_failed'\)/u);
  assert.match(resting.text, /PARTITION BY i\.channel_id ORDER BY i\.updated_at DESC/u);
});

test("a resting Presence row with a live or stopped state fails closed", async () => {
  for (const bad of [{ status: "online", rest_state: "sleeping" }, { status: "offline", rest_state: "stopped" }]) {
    const transaction = { async query(input) {
      return input.name === "channel_agent_resting_presence_v4" ? [row(bad)] : [];
    } };
    await assert.rejects(loadChannelAgentPresence(transaction, "space-1", ["channel-1"]),
      (error) => error instanceof DatabaseContractError &&
        error.message === "Resting Agent presence state is invalid");
  }
});

test("sleeping and live catalogs keep Instance counters while discarding a legacy quota copy", async () => {
  const usage = { totalTokens: 7, contextUsedTokens: 3, quotaSource: "provider_api", quotaObservedAt: "2026-09-05T00:00:00Z",
    quotaUsages: [{ label: "5h", percent: 99 }] };
  const result = await loadChannelAgentPresence({ async query(input) {
    return input.name === "channel_agent_presence_v8" ? [row({ instance_usage: usage })]
      : [row({ instance_id: "sleeping", status: "offline", rest_state: "sleeping", instance_usage: usage })];
  } }, "space-1", ["channel-1"]);
  for (const presence of Object.values(result.get("channel-1"))) {
    assert.deepEqual(presence.instances[0].usage, { totalTokens: 7, contextUsedTokens: 3 });
    assert.deepEqual(presence.usage, { totalTokens: 7, contextUsedTokens: 3 });
  }
});

test("durable presentation projects model, effort and chips, and drops a chip it cannot show", async () => {
  const chips = [{ id: "model", label: "Model", value: "gpt-5.4", source: "codex", parameterKind: "enum" }];
  const result = await loadChannelAgentPresence({ async query(input) {
    if (input.name === "channel_agent_resting_presence_v4") return [];
    return [
      row({ instance_model: "gpt-5.4", instance_effort: "high", instance_status_chips: chips }),
      row({ instance_id: "instance-2", channel_instance_id: 7, instance_status_chips: [{ id: "quota", label: "5h", percent: 120 }] }),
    ];
  } }, "space-1", ["channel-1"]);
  const presence = result.get("channel-1");
  assert.equal(presence["instance-1"].instances[0].model, "gpt-5.4");
  assert.equal(presence["instance-1"].instances[0].effort, "high");
  assert.deepEqual(presence["instance-1"].instances[0].statusChips, chips);
  assert.equal(presence["instance-2"].instances[0].model, undefined);
  assert.equal(presence["instance-2"].instances[0].statusChips, undefined);
});

test("visible live agents are the channels this principal may read", async () => {
  const names = [];
  const found = await loadVisibleLiveAgentPresence({ async query(input) {
    names.push(input.name);
    if (input.name === "visible_live_agent_channels_v1") {
      assert.deepEqual(input.values, ["space-1", "agent", "agent-1"]);
      assert.match(input.text, /channel_member\.user_id=\$3/u);
      assert.match(input.text, /subject_kind='agent'/u);
      assert.match(input.text, /management_channel_about/u);
      assert.match(input.text, /LIMIT 200/u);
      return [{ channel_id: "channel-1" }];
    }
    if (input.name === "channel_agent_resting_presence_v4") return [];
    return [row()];
  } }, "space-1", { kind: "agent", id: "agent-1" });
  assert.deepEqual(names, [
    "visible_live_agent_channels_v1",
    "channel_agent_presence_v8",
    "channel_agent_resting_presence_v4",
  ]);
  assert.equal(found.get("channel-1")["instance-1"].instances[0].id, "instance-1");
});
