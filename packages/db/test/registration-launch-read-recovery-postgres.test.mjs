import assert from "node:assert/strict";
import { PostgresRegistrationLaunchRepository } from "../dist/agent-registration-launch.js";
import { integration } from "./postgres-database.fixture.mjs";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";
import { recoveringDatabase } from "./response-fault-postgres.fixture.mjs";

// Healthy launch tests own selection and commit reconciliation. They bypass
// the real client's recovery; generic client tests cannot catch this caller
// retaining a transaction around the model catalog (HUB-BZ).
integration("launch candidate reads recover once without preparing work (XMATRIX-HUB-BZ)", async () => {
  const f = await spaceSecretFixture();
  let fault;
  const { database, clients } = recoveringDatabase(() => fault);
  const placement = { spaceId: f.ids.space, shardId: "shard-0", placementEpoch: 1 };
  const launches = new PostgresRegistrationLaunchRepository(database, database, placement);
  const read = () => launches.readHarnessToStart({ actorUserId: f.ids.owner, body: "Synthetic routing check" },
    async ({ candidates }) => {
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].key.machineId, f.ids.machine);
      assert.equal(candidates[0].modelCatalog[0].model, "observed-model");
      return { key: candidates[0].key, model: "", useRuntimeDefaultModel: true };
    });
  const lose = (matches, extra = {}) => fault = { matches, remaining: 1,
    error: new Error("Query read timeout"), checkouts: [], ...extra };
  try {
    await f.client.query(`INSERT INTO control.machine_execution_capacity VALUES ($1,$2,2,1,now())`,
      [f.ids.owner, f.ids.machine]);
    await f.client.query(`INSERT INTO control.agent_registration_environments VALUES ($1,$2,'claude',$3,1,now())`,
      [f.ids.owner, f.ids.machine, { schemaVersion: 1, enabled: true, models: [],
        availability: "interactive", maxConcurrent: 2, capabilities: [], description: "" }]);
    await f.client.query(`UPDATE data.machine_daemons SET capabilities_json=$2 WHERE daemon_id=$1`,
      [f.ids.daemon, JSON.stringify(["registration_launch_v3", "registration_managed_v1", "registration_optional_model_v1"])]);
    await f.client.query(`UPDATE data.instances SET presentation_json=$2 WHERE instance_id=$1`,
      [f.ids.instance, { models: [{ model: "observed-model" }], modelsObservedAt: new Date().toISOString() }]);
    assert.equal(await read(), "claude");
    const stages = [/catalog\.models,catalog\.observed_at/u, /percentile_cont/u,
      /FROM data\.space_agent_registrations r/u, /FROM data\.workspaces/u,
      /FROM data\.machine_daemons WHERE/u, /FROM control\.agent_registration_environments e/u];
    for (const matches of stages) {
      const before = clients.length;
      lose(matches);
      assert.equal(await read(), "claude");
      assert.equal(fault.checkouts.length, 1);
      assert.ok(fault.checkouts[0].ended);
      assert.ok(clients.indexOf(fault.checkouts[0]) < clients.length - 1, "recovery uses a fresh connection");
      assert.ok(clients.slice(before).every(c => c.ended && !c.queries.some(sql => /^(BEGIN|COMMIT)/u.test(sql))),
        "each read closes its session without transaction round trips");
    }
    for (const [error, attempts] of [[new Error("Query read timeout"), 2],
      [Object.assign(new Error("statement timeout"), { code: "57014" }), 1]]) {
      lose(stages[0], { remaining: 3, error });
      await assert.rejects(read(), error);
      assert.equal(fault.checkouts.length, attempts, "only a lost response retries, once");
    }
    lose(stages[0], { beforeThrow: () => f.client.query(
      "UPDATE control.space_placement SET placement_epoch=2 WHERE space_id=$1", [f.ids.space]) });
    await assert.rejects(read(), /local Space placement fence is stale/u);
    assert.equal(fault.checkouts.length, 1, "a retry checks the current placement");
    fault = undefined;
    await f.client.query("UPDATE control.space_placement SET placement_epoch=1 WHERE space_id=$1", [f.ids.space]);
    lose(stages[2], { beforeThrow: () => f.client.query(
      "UPDATE data.space_agent_registration_access SET grant_state='revoked' WHERE space_id=$1", [f.ids.space]) });
    await assert.rejects(read(), { code: "registration_not_found" });
    assert.equal(fault.checkouts.length, 1, "a retry does not reuse a revoked registration");
    assert.equal((await f.client.query("SELECT count(*)::int n FROM data.registration_launch_intents WHERE space_id=$1",
      [f.ids.space])).rows[0].n, 0, "reading candidates never prepares a launch");
  } finally {
    await f.client.query("DELETE FROM control.agent_registration_environments WHERE owner_user_id=$1", [f.ids.owner]);
    await f.client.query("DELETE FROM control.machine_execution_capacity WHERE owner_user_id=$1", [f.ids.owner]);
    await f.close();
  }
});
