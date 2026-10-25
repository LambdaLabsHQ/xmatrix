import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresMachineControlRepository, PostgresSpaceControlRepository } from "@xmatrix/db";

import { RelayRuntimeLive } from "../src/relay-runtime.ts";
import { createProductionRelayRuntimeProductPortFactory } from "../src/runtime-transport/production-product-port-factory.ts";
import { publishHumanChannelCatalogChangedToSessions } from "../src/connections/human/registry.ts";
import { FakeSocket } from "./support/runtime-transport.mjs";
import { recordingRuntimeNamespace } from "./support/runtime-namespace.mjs";

// HUB-8B: the task committed and wrote the About, then its catalog notification
// fetched the Runtime still handling the completion. The previous e2e waited
// long enough for the 30-second queue escape and never asserted this boundary.
test("an About completion delivers its catalog locally and acknowledges without fetching its own Runtime", async (t) => {
  const requestId = "channel-about:channel-1:0:5:summary:123e4567-e89b-12d3-a456-426614174000";
  const committed = [];
  t.mock.method(PostgresMachineControlRepository.prototype, "command", async (input) => {
    committed.push(input.action);
    return {};
  });
  t.mock.method(PostgresSpaceControlRepository.prototype, "resolveChannelSpaceId", async () => "space-1");
  t.mock.method(PostgresSpaceControlRepository.prototype, "mutateChannel", async (input) => {
    assert.equal(input.summary, "Ready to ship");
    assert.equal(input.actorUserId, "owner");
    assert.equal(input.summaryAuthor.taskId, requestId);
    committed.push("about");
    return { entityVersion: 1 };
  });
  t.mock.method(PostgresSpaceControlRepository.prototype, "channelCatalogChangeAudiences", async () => [
    { spaceId: "space-1", revision: 7, recipientUserIds: ["owner", "reader"] },
  ]);
  t.mock.method(PostgresSpaceControlRepository.prototype, "getChannel", async () => ({ channel: { id: "channel-1" } }));

  // Both legacy cell-0 and the current owner cell can be the publishing Runtime.
  for (const cell of ["cell-0", "user-owner"]) {
    const local = ["owner", "reader", "outsider"].map(userId => [new FakeSocket(), { userId }]);
    const runtime = Object.create(RelayRuntimeLive.prototype);
    runtime.productAdapter = {
      publishHumanChannelCatalogChanged: (message, recipientUserIds) =>
        publishHumanChannelCatalogChangedToSessions({ message, recipientUserIds }, local, (socket, frame) => {
          socket.send(JSON.stringify(frame));
          return true;
        }),
    };
    const remote = [];
    const selfRpc = [];
    const localRequests = [];
    const env = {
      RELAY_POSTGRES: { connectionString: "postgres://authority.invalid/xmatrix" },
      RELAY_POSTGRES_SHARD_ID: "shard-0",
      XMATRIX_RUNTIME_CELL_MODE: "dual",
      RELAY_RUNTIME_ROUTE_DIRECTORY: { idFromName: name => name, get: () => ({ fetch: async () =>
        Response.json({ routes: [{ cellName: cell, expiresAtMs: Date.now() + 60_000 }] }) }) },
      RELAY_RUNTIME: recordingRuntimeNamespace(remote, async (target, request) => {
        if (target === cell) {
          selfRpc.push(target);
          throw new Error("Self RPC cannot complete while its socket event is running");
        }
        assert.equal(new URL(request.url).pathname, "/internal/committed-event");
        return Response.json({ delivered: 1 });
      }),
    };
    const factory = createProductionRelayRuntimeProductPortFactory(env, {
      runtimeSelf: { cellName: () => cell, fetch: request => {
        localRequests.push(request.url);
        return runtime.fetch(request);
      } },
    });
    const reply = await factory.machineDaemon().execute({
      principal: { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "machine", hostId: "host" },
      connectionEpoch: 1, capabilities: ["machine_text_task_v1"],
    }, { type: "machine_text_task_result", requestId,
      result: { presetId: "codex", status: "completed", text: '{"summary":"Ready to ship"}' } });
    assert.deepEqual(reply, { type: "machine_command_completion_acked", requestId, controlId: requestId });
    assert.deepEqual(selfRpc, [], "the publishing cell must never receive an RPC to itself");
    assert.equal(localRequests.length, 1);
    assert.deepEqual(local.map(([socket]) => socket.sent), [
      [{ type: "space_channel_catalog_changed", spaceId: "space-1", revision: 7 }],
      [{ type: "space_channel_catalog_changed", spaceId: "space-1", revision: 7 }],
      [],
    ], "local delivery retains the authoritative audience");
    // The recipients' own cells are reached too, except the one publishing.
    assert.deepEqual(remote.map(({ cell: target }) => target).sort(),
      ["cell-0", "user-owner", "user-reader"].filter((target) => target !== cell));
  }
  assert.deepEqual(committed, ["complete", "about", "complete", "about"]);
});
