import assert from "node:assert/strict";
import test from "node:test";

import {
  listOwnerWorkspaces,
  workspaceRepository,
} from "../src/postgres-workspace-authority.ts";

function workspaceDatabase(queries) {
  return {
    cacheMode: "disabled",
    async transaction(_context, callback) {
      return callback({
        async query(query) {
          queries.push(query);
          if (query.name !== "workspace_list_v3") return [];
          return [{
            owner_user_id: "user-1",
            machine_id: "machine-1",
            canonical_cwd: "/srv/xmatrix",
            metadata_json: { hostId: "host-1" },
            created_at: "2026-09-04T00:00:00.000Z",
            updated_at: "2026-09-04T00:00:00.000Z",
          }];
        },
      });
    },
  };
}

test("an owner's workspaces on one machine are read with an exact machine filter", async () => {
  const queries = [];
  const workspaces = await listOwnerWorkspaces(workspaceRepository({
    RELAY_POSTGRES: { connectionString: "postgres://unused" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
  }, workspaceDatabase(queries)), "user-1", "machine-1");

  assert.deepEqual(queries[0].values, ["user-1", "machine-1", null, null, 201]);
  assert.match(queries[0].text, /machine_id = \$2/u);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].machineId, "machine-1");
});
