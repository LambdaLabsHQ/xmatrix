import assert from "node:assert/strict";
import { PostgresRegistrationLaunchRepository } from "../dist/agent-registration-launch.js";
import { integration } from "./postgres-database.fixture.mjs";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";
import { recoveringDatabase } from "./response-fault-postgres.fixture.mjs";

/** A Space and launch repository whose client can lose one response on demand. */
async function recoveringLaunches() {
  const f = await spaceSecretFixture();
  const state = { fault: undefined };
  const { database, clients } = recoveringDatabase(() => state.fault);
  const placement = { spaceId: f.ids.space, shardId: "shard-0", placementEpoch: 1 };
  const launches = new PostgresRegistrationLaunchRepository(database, database, placement);
  const lose = (matches, extra = {}) => state.fault = { matches, remaining: 1,
    error: new Error("Query read timeout"), checkouts: [], ...extra };
  /** Lose one response to `matches` and assert the read recovered on a fresh, transaction-free connection. */
  const recovered = async (matches, read) => {
    state.fault = undefined;
    const before = clients.length;
    lose(matches);
    const value = await read();
    assert.equal(state.fault.checkouts.length, 1);
    assert.ok(state.fault.checkouts[0].ended);
    assert.ok(clients.indexOf(state.fault.checkouts[0]) < clients.length - 1, "recovery uses a fresh connection");
    assert.ok(clients.slice(before).every(c => c.ended && !c.queries.some(sql => /^(BEGIN|COMMIT)/u.test(sql))),
      "the read closes its session without transaction round trips");
    return value;
  };
  return { f, state, clients, launches, lose, recovered };
}

/** The Machine capacity row and the claude environment a launch reads. */
async function launchEnvironment(f) {
  await f.client.query(`INSERT INTO control.machine_execution_capacity VALUES ($1,$2,2,1,now())`,
    [f.ids.owner, f.ids.machine]);
  await f.client.query(`INSERT INTO control.agent_registration_environments VALUES ($1,$2,'claude',$3,1,now())`,
    [f.ids.owner, f.ids.machine, { schemaVersion: 1, enabled: true, models: [],
      availability: "interactive", maxConcurrent: 2, capabilities: [], description: "" }]);
}

// Healthy launch tests own selection and commit reconciliation. They bypass
// the real client's recovery; generic client tests cannot catch this caller
// retaining a transaction around the model catalog (HUB-BZ).
integration("launch candidate reads recover once without preparing work (XMATRIX-HUB-BZ)", async () => {
  const { f, state, launches, lose, recovered } = await recoveringLaunches();
  const read = () => launches.readHarnessToStart({ actorUserId: f.ids.owner, body: "Synthetic routing check" },
    async ({ candidates }) => {
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].key.machineId, f.ids.machine);
      assert.equal(candidates[0].modelCatalog[0].model, "observed-model");
      return { key: candidates[0].key, model: "", useRuntimeDefaultModel: true };
    });
  try {
    await launchEnvironment(f);
    await f.client.query(`UPDATE data.machine_daemons SET capabilities_json=$2 WHERE daemon_id=$1`,
      [f.ids.daemon, JSON.stringify(["registration_launch_v3", "registration_managed_v1", "registration_optional_model_v1"])]);
    await f.client.query(`UPDATE data.instances SET presentation_json=$2 WHERE instance_id=$1`,
      [f.ids.instance, { models: [{ model: "observed-model" }], modelsObservedAt: new Date().toISOString() }]);
    assert.equal(await read(), "claude");
    const stages = [/catalog\.models,catalog\.observed_at/u, /percentile_cont/u,
      /FROM data\.space_agent_registrations r/u, /FROM data\.workspaces/u,
      /FROM data\.machine_daemons WHERE/u, /FROM control\.agent_registration_environments e/u];
    for (const matches of stages) {
      assert.equal(await recovered(matches, read), "claude");
    }
    for (const [error, attempts] of [[new Error("Query read timeout"), 2],
      [Object.assign(new Error("statement timeout"), { code: "57014" }), 1]]) {
      lose(stages[0], { remaining: 3, error });
      await assert.rejects(read(), error);
      assert.equal(state.fault.checkouts.length, attempts, "only a lost response retries, once");
    }
    lose(stages[0], { beforeThrow: () => f.client.query(
      "UPDATE control.space_placement SET placement_epoch=2 WHERE space_id=$1", [f.ids.space]) });
    await assert.rejects(read(), /local Space placement fence is stale/u);
    assert.equal(state.fault.checkouts.length, 1, "a retry checks the current placement");
    state.fault = undefined;
    await f.client.query("UPDATE control.space_placement SET placement_epoch=1 WHERE space_id=$1", [f.ids.space]);
    lose(stages[2], { beforeThrow: () => f.client.query(
      "UPDATE data.space_agent_registration_access SET grant_state='revoked' WHERE space_id=$1", [f.ids.space]) });
    await assert.rejects(read(), { code: "registration_not_found" });
    assert.equal(state.fault.checkouts.length, 1, "a retry does not reuse a revoked registration");
    assert.equal((await f.client.query("SELECT count(*)::int n FROM data.registration_launch_intents WHERE space_id=$1",
      [f.ids.space])).rows[0].n, 0, "reading candidates never prepares a launch");
  } finally {
    await f.client.query("DELETE FROM control.agent_registration_environments WHERE owner_user_id=$1", [f.ids.owner]);
    await f.client.query("DELETE FROM control.machine_execution_capacity WHERE owner_user_id=$1", [f.ids.owner]);
    await f.close();
  }
});

// A `machine:` condition reads the owner's name for that Machine on the
// directory authority. It is a lock-free single-row read, so it must run as
// single_read and recover once from a stalled first round trip instead of
// failing the launch (XMATRIX-HUB-CW).
integration("a machine-name read recovers once without opening a transaction (XMATRIX-HUB-CW)", async () => {
  const { f, state, launches, lose, recovered } = await recoveringLaunches();
  const name = "recovery-box";
  // TypeScript private methods are ordinary prototype methods at runtime; this
  // exercises the same read the launch preparation performs.
  const read = () => launches.machineKnownAs(f.ids.owner, f.ids.machine, name);
  try {
    await f.client.query(`INSERT INTO data.machines (owner_user_id,machine_id,name) VALUES ($1,$2,$3)`,
      [f.ids.owner, f.ids.machine, name]);
    assert.equal(await read(), true);
    assert.equal(await launches.machineKnownAs(f.ids.owner, f.ids.machine, "someone-else"), false);
    const machineRead = /FROM data\.machines WHERE owner_user_id/u;
    assert.equal(await recovered(machineRead, read), true);
    lose(machineRead, { remaining: 2, error: Object.assign(new Error("statement timeout"), { code: "57014" }) });
    await assert.rejects(read(), /statement timeout/u);
    assert.equal(state.fault.checkouts.length, 1, "an answered failure is final, never replayed");
  } finally {
    try {
      await f.client.query(`DELETE FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2`,
        [f.ids.owner, f.ids.machine]);
    } finally { await f.close(); }
  }
});

// Every other lock-free single-row read on the launch path takes the same
// route: settings before the commit, the host after it, and the two recovery
// origins. A stalled first round trip there must not fail work that never
// opened a transaction (XMATRIX-HUB-CW).
integration("launch settings, host and fallback reads recover once without opening a transaction (XMATRIX-HUB-CW)", async () => {
  const { f, state, launches, lose, recovered } = await recoveringLaunches();
  const request = { commandId: "recovery-launch", key: {
    spaceId: f.ids.space, ownerUserId: f.ids.owner, machineId: f.ids.machine, harness: "claude" },
  requirements: { model: "observed-model" } };
  try {
    await launchEnvironment(f);
    assert.equal(await launches.launchSettings(request, 1), undefined);
    assert.equal(await recovered(/FROM control\.agent_registration_environments/u,
      () => launches.launchSettings(request, 1)), undefined);

    assert.deepEqual(await launches.withHost("recovery-host", { launchId: "missing-launch" }),
      { launchId: "missing-launch", hostId: "" });
    assert.deepEqual(await recovered(/FROM data\.agent_launches WHERE launch_id/u,
      () => launches.withHost("recovery-host", { launchId: "missing-launch" })),
    { launchId: "missing-launch", hostId: "" });

    const fallback = { commandId: "recovery-fallback", channelId: f.ids.channel, runId: f.ids.run,
      readBody: async () => undefined };
    assert.equal(await launches.startupFallbackOrigin(fallback), undefined);
    assert.equal(await recovered(/FROM data\.registration_launch_intents intent JOIN data\.messages message/u,
      () => launches.startupFallbackOrigin(fallback)), undefined);

    const handoff = { commandId: "recovery-handoff", channelId: f.ids.channel, runId: f.ids.run };
    assert.equal(await launches.handoffFallbackOrigin(handoff), undefined);
    assert.equal(await recovered(/launch\.spawn_payload_json->>'prompt'/u,
      () => launches.handoffFallbackOrigin(handoff)), undefined);

    lose(/FROM data\.agent_launches WHERE launch_id/u, { remaining: 2,
      error: Object.assign(new Error("statement timeout"), { code: "57014" }) });
    await assert.rejects(launches.withHost("recovery-host", { launchId: "missing-launch" }), /statement timeout/u);
    assert.equal(state.fault.checkouts.length, 1, "an answered failure is final, never replayed");
  } finally {
    try {
      await f.client.query("DELETE FROM control.agent_registration_environments WHERE owner_user_id=$1", [f.ids.owner]);
      await f.client.query("DELETE FROM control.machine_execution_capacity WHERE owner_user_id=$1", [f.ids.owner]);
    } finally { await f.close(); }
  }
});
