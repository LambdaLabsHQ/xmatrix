import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase, ConnectivityBreaker, PostgresAgentRegistrationRepository } from "../dist/index.js";
import { retryPool } from "./retry-pool.fixture.mjs";

const placement = { spaceId: "space-1", shardId: "shard-0", placementEpoch: 2 };
const listing = { spaceId: placement.spaceId, actorUserId: "owner", requestId: "catalog-recovery" };
const catalogRow = { __xmatrix_fence_shard_id: "shard-0", __xmatrix_fence_placement_epoch: 2,
  __xmatrix_fence_state: "active", __xmatrix_fence_target_shard_id: null, __xmatrix_read_row: true,
  shard_id: "shard-0", placement_epoch: 2, state: "active", target_shard_id: null, role: "member",
  reader_role: "member", owner_user_id: "owner", machine_id: "machine", harness: "codex",
  display_name: "Agent", configuration_json: { workspaceReferences: [] }, version: 1,
  current_owner: "owner", grant_state: "active", policy_state: "enabled" };

// Existing PostgreSQL tests own visibility, pagination and private projections.
// These exercise the real client's recovery at both catalog call sites, which
// neither generic recovery tests nor savepoint-backed SQL tests can select.
for (const phase of ["page", "labels"]) {
  for (const repeat of [false, true]) {
    test(`registration ${phase} ${repeat ? "surfaces a second loss" : "recovers a lost response"}`, async () => {
      const second = new Error("Query read timeout");
      const fake = retryPool(phase === "page" ? /space_agent_registrations/u : /jsonb_to_recordset/u,
        [new Error("Query read timeout"), ...(repeat ? [second] : [])], undefined, [], [catalogRow]);
      const database = createAuthorityDatabase({ connectionString: "postgres://example.invalid/xmatrix",
        shardId: placement.shardId, poolFactory: fake.factory, connectivityBreaker: new ConnectivityBreaker("shard-0") });
      const session = database.openSession();
      const read = () => new PostgresAgentRegistrationRepository(session, placement).list(listing);
      if (repeat) await assert.rejects(read, error => error === second);
      else {
        const page = await read();
        assert.equal(page.registrations[0].displayName, "Agent");
        assert.equal(page.registrations[0].canConfigureSpace, false);
        assert.equal(page.nextCursor, null);
      }
      await session.close();
      assert.equal(fake.clients.length, 2,
        "each independent statement has at most two checkouts");
      assert.equal(fake.clients[0].releases[0], true, "the first failed connection is destroyed");
      const failed = fake.clients.filter(client => client.releases[0] === true);
      assert.equal(failed.length, repeat ? 2 : 1);
      const queries = fake.clients.flatMap(client => client.queries);
      assert.equal(queries.length, repeat && phase === "page" ? 2 : 3);

    });
  }
}

test("registration catalog listing tolerates stored legacy refused backends such as zcode-app", async () => {
  const zcodeRow = { ...catalogRow, harness: "zcode", display_name: "zcode" };
  const labelRow = {
    owner: "owner", machine: "machine", harness: "zcode", name: "Workstation",
    declaration_json: {
      schemaVersion: 1, enabled: true, models: [], description: "",
      availability: "interactive", capabilities: [],
      launch: { runtime: "zcode", runtimeArgs: [], backend: "zcode-app" },
    },
    online: false,
  };
  const database = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix",
    shardId: placement.shardId,
    connectivityBreaker: new ConnectivityBreaker("shard-0"),
    poolFactory: () => ({
      async connect() {
        return {
          async query(input) {
            const text = typeof input === "string" ? input : input.text;
            const rows = text.includes("jsonb_to_recordset") ? [labelRow] : [zcodeRow];
            return { rows, rowCount: rows.length };
          },
          release() {},
        };
      },
      async end() {},
    }),
  });
  const session = database.openSession();
  const page = await new PostgresAgentRegistrationRepository(session, placement).list(listing);
  await session.close();
  assert.equal(page.registrations.length, 1);
  assert.equal(page.registrations[0].key.harness, "zcode");
  assert.equal(page.registrations[0].machineName, "Workstation");
});
