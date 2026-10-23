import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase, readHarnessReleaseTargets } from "../dist/index.js";

// The client owns generic retry coverage; this guards this real repository
// read's opt-in, which used to abort the whole pass on one lost SQL response.
test("a stalled release target read destroys its checkout and returns targets from a fresh one", async () => {
  const clients = [];
  const row = { preset_id: "claude", owner_user_id: "owner", owner_email: "owner@example.test",
    machine_id: "machine", hostname: "host", daemon_id: "daemon" };
  const session = createAuthorityDatabase({ connectionString: "postgres://fixture", shardId: "shard-0",
    poolFactory: () => ({ async connect() {
      const attempt = clients.length;
      const client = { releases: [], async query(input) {
        const text = typeof input === "string" ? input : input.text;
        if (!text.includes("FROM unnest")) return { rows: [], rowCount: 0 };
        if (attempt === 0) throw new Error("Query read timeout");
        return { rows: [row], rowCount: 1 };
      }, release(destroy) { this.releases.push(destroy); } };
      clients.push(client);
      return client;
    }, async end() {} }) }).openSession();
  try {
    assert.deepEqual(await readHarnessReleaseTargets(session, { requestId: "release-read",
      releases: [{ presetId: "claude", version: "2.0.0" }] }), [{ presetId: "claude", ownerUserId: "owner",
      ownerEmail: "owner@example.test", machineId: "machine", hostId: "host", daemonId: "daemon" }]);
    assert.equal(clients.length, 2);
    assert.deepEqual(clients[0].releases, [true]);
  } finally { await session.close(); }
  assert.deepEqual(clients[1].releases, [false]);
});
