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
      relayRuntimeCellsForOwners: (_env, owners) => owners.map((owner) => `user-${owner}`)
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
    "user-owner": { availability: "available", complete: true, events: [], nextCursor: null },
  });
  const response = await read(app);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).availability, "available");
  assert.deepEqual(asked, ["user-owner"]);
});

test("a host its owner's cell does not hold reads offline", async () => {
  const body = await (await read(fixture({ "user-owner": offline }).app)).json();
  assert.equal(body.availability, "unavailable");
  assert.equal(body.reason, "host_offline");
});
