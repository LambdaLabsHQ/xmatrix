import assert from "node:assert/strict";
import test from "node:test";

import { startHubWorker } from "./e2e-utils.mjs";

test("PostgreSQL Channel coordinator is callable across the Cloudflare RPC boundary", async (t) => {
  const worker = await startHubWorker();
  t.after(() => worker.stop());
  const response = await worker.fetch("/__test/postgres-channel-coordinator-rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channelId: "channel-rpc-1",
      commandId: "command-rpc-1",
      observedPostgresHead: 4,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reservation: {
      channelId: "channel-rpc-1",
      commandId: "command-rpc-1",
      sequence: 5,
      state: "reserved",
    },
    status: {
      channelId: "channel-rpc-1",
      allocatedSequence: 5,
      confirmedSequence: 4,
      reservationCount: 1,
    },
  });
});
