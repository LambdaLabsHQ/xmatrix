import assert from "node:assert/strict";
import test from "node:test";
import { createObservabilityMemoryApp } from "./support/observability-memory-routes.mjs";

const env = { RELAY_POSTGRES: { connectionString: "postgres://test" }, RELAY_POSTGRES_SHARD_ID: "shard-test" };

function fixture(cellAnswers) {
  const asked = [];
  class PostgresTraceAccessRepository {
    async authorize({ instanceId }) {
      return { allowed: true, traceRoute: { instanceId, channelId: "channel-1", terminal: false, ownerUserId: "owner" } };
    }
  }
  const imports = {
    "@xmatrix/db": { PostgresTraceAccessRepository },
    "./relay-runtime": { RELAY_RUNTIME_AGENT_TRACE_PATH: "/internal/product-trace/instance-events" },
    "./relay-authority-locator": {
      relayRuntimeCellsForOwners: (_env, owners) => ["cell-0", ...owners.map((owner) => `user-${owner}`)]
        .map((name) => ({ fetch: async () => { asked.push(name); return Response.json(cellAnswers[name]); } })),
    },
    "./trace-authorization-batch": { traceAuthorizationChecksForChannels: () => [] },
    "./index-shared": {
      requireAuth: async () => ({ id: "owner" }),
      getRelayRuntime: () => { throw new Error("trace reads name the owner's cells"); },
      requestErrorResponse: (context, error) => context.json({ error: error.message }, 500),
    },
  };
  const app = createObservabilityMemoryApp(imports);
  return { app, asked };
}

const offline = { availability: "unavailable", complete: false, events: [], reason: "host_offline" };
const read = (app) => app.request("/api/trace/instances/instance-1/events?limit=10", {}, env);

test("a trace read reaches the host whose socket is in its owner's cell", async () => {
  const { app, asked } = fixture({
    "cell-0": offline,
    "user-owner": { availability: "available", complete: true, events: [], nextCursor: null },
  });
  const response = await read(app);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).availability, "available");
  assert.deepEqual(asked.sort(), ["cell-0", "user-owner"]);
});

test("a host still on the single cell answers too, and no cell holding it says offline", async () => {
  const legacy = fixture({
    "cell-0": { availability: "available", complete: true, events: [], nextCursor: null },
    "user-owner": offline,
  });
  assert.equal((await (await read(legacy.app)).json()).availability, "available");

  const absent = fixture({ "cell-0": offline, "user-owner": offline });
  const body = await (await read(absent.app)).json();
  assert.equal(body.availability, "unavailable");
  assert.equal(body.reason, "host_offline");
});
