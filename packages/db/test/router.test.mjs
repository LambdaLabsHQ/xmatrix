import assert from "node:assert/strict";
import test from "node:test";

import { DatabasePlacementStaleError, SpacePlacementHints } from "../dist/index.js";
import { createAuthorityDatabaseRouter } from "../dist/router.js";

function database(name) {
  const calls = [];
  return {
    name, calls, cacheMode: "disabled",
    async transaction(context, callback) {
      calls.push({ kind: "transaction", context });
      return callback({ async query() { return []; } });
    },
    async health(context) {
      calls.push({ kind: "health", context });
      return { ok: true, latencyMs: 1, shardId: name };
    },
  };
}

test("database router sends directory and placed work to disjoint correctness connections", async () => {
  const directory = database("directory");
  const zero = database("shard-0");
  const one = database("shard-1");
  const router = createAuthorityDatabaseRouter({ directory,
    shards: { "shard-0": zero, "shard-1": one } });

  await router.transaction({ requestId: "directory-read", operation: "placement.resolve" },
    async () => "directory");
  await router.transaction({ requestId: "space-write", operation: "message.append",
    placement: { spaceId: "space-1", shardId: "shard-1", placementEpoch: 3 } },
  async () => "shard");

  assert.equal(directory.calls.length, 1);
  assert.equal(zero.calls.length, 0);
  assert.equal(one.calls.length, 1);
  assert.equal(one.calls[0].context.placement.placementEpoch, 3);
});

test("database router fails closed when placement names an unconfigured shard", async () => {
  const router = createAuthorityDatabaseRouter({ directory: database("directory"),
    shards: { "shard-0": database("shard-0") } });
  await assert.rejects(router.transaction({ requestId: "space-write", operation: "message.append",
    placement: { spaceId: "space-1", shardId: "shard-9", placementEpoch: 1 } }, async () => {}),
  /no configured correctness connection/u);
});

test("database router health probes the selected physical route", async () => {
  const directory = database("directory");
  const one = database("shard-1");
  const router = createAuthorityDatabaseRouter({ directory, shards: { "shard-1": one } });
  assert.equal((await router.health({ requestId: "health-1", operation: "health",
    placement: { spaceId: "space-1", shardId: "shard-1", placementEpoch: 2 } })).shardId,
  "shard-1");
  assert.equal(directory.calls.length, 0);
  assert.equal(one.calls[0].kind, "health");
});

function sessionDatabase(name) {
  const root = database(name);
  root.sessionOpens = 0;
  root.sessionCloses = 0;
  root.openSession = () => {
    root.sessionOpens += 1;
    const session = database(`${name}-session`);
    session.openSession = root.openSession;
    session.close = async () => { root.sessionCloses += 1; };
    root.sessions ??= [];
    root.sessions.push(session);
    return session;
  };
  return root;
}

test("request router reuses shard-0 and bounds shard-1 to directory plus shard", async () => {
  const zero = sessionDatabase("shard-0");
  const one = sessionDatabase("shard-1");
  const router = createAuthorityDatabaseRouter({
    directory: zero,
    shards: { "shard-0": zero, "shard-1": one },
  });
  const scope = router.openSession();
  await scope.transaction({ requestId: "directory", operation: "channel.resolve-space" },
    async () => undefined);
  await scope.transaction({ requestId: "zero", operation: "message.prepare-append",
    placement: { spaceId: "space-0", shardId: "shard-0", placementEpoch: 1 } },
  async () => undefined);
  assert.equal(zero.sessions[0].calls.filter((call) => call.kind === "transaction").length, 2);
  assert.equal(one.sessions[0].calls.length, 0);

  await scope.transaction({ requestId: "one", operation: "message.append",
    placement: { spaceId: "space-1", shardId: "shard-1", placementEpoch: 1 } },
  async () => undefined);
  assert.equal(one.sessions[0].calls.filter((call) => call.kind === "transaction").length, 1);
  await scope.close();
  assert.equal(zero.sessionOpens, 1);
  assert.equal(one.sessionOpens, 1);
  assert.equal(zero.sessionCloses, 1);
  assert.equal(one.sessionCloses, 1);
});

/** A shard whose fence admits exactly one placement epoch, and a directory that reports it. */
function fencedFleet({ directoryRow, admittedEpoch, hints }) {
  const directory = {
    ...database("directory"), placementHints: hints,
    async transaction(context, callback) {
      directory.calls.push({ kind: "transaction", context });
      return callback({ async query() { return directoryRow ? [directoryRow] : []; } });
    },
  };
  const shard = (name) => {
    const fenced = database(name);
    fenced.transaction = async (context, callback) => {
      fenced.calls.push({ kind: "transaction", context });
      if (context.placement.placementEpoch !== admittedEpoch || name !== directoryRow?.shard_id) {
        throw new DatabasePlacementStaleError(context.placement.spaceId);
      }
      return callback({ async query() { return [{ ok: true }]; } });
    };
    return fenced;
  };
  const zero = shard("shard-0");
  const one = shard("shard-1");
  return { directory, zero, one,
    router: createAuthorityDatabaseRouter({ directory, shards: { "shard-0": zero, "shard-1": one } }) };
}

const row = (shardId, epoch, state = "active", target = null) => ({ space_id: "space-1", shard_id: shardId,
  placement_epoch: epoch, state, target_shard_id: target, plan_class: "shared" });
const stalePlacement = { requestId: "write-1", operation: "message.append",
  placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 } };

test("a refused placement is rerouted once by the directory's current placement", async () => {
  const hints = new SpacePlacementHints();
  const fleet = fencedFleet({ directoryRow: row("shard-1", 2), admittedEpoch: 2, hints });
  let runs = 0;
  const result = await fleet.router.transaction(stalePlacement, async (transaction) => {
    runs += 1;
    return transaction.query({ name: "work_v1", text: "SELECT 1", maxRows: 1 });
  });
  assert.deepEqual(result, [{ ok: true }]);
  assert.equal(runs, 1, "the refused attempt ran none of the work");
  assert.equal(fleet.zero.calls.length, 1);
  assert.deepEqual(fleet.one.calls[0].context.placement,
    { spaceId: "space-1", shardId: "shard-1", placementEpoch: 2 });
  assert.equal(hints.get("space-1")?.shardId, "shard-1", "the current placement becomes the hint");
  assert.equal(fleet.router.placementHints, hints);
});

test("a refused placement fails closed when the directory has nothing newer to route by", async () => {
  for (const [directoryRow, expected] of [
    [row("shard-0", 1), /local Space placement fence is stale/u],
    [row("shard-0", 2, "moving", "shard-1"), /Space placement is unavailable/u],
    [undefined, /Space placement is unavailable/u],
  ]) {
    const fleet = fencedFleet({ directoryRow, admittedEpoch: 9 });
    await assert.rejects(fleet.router.transaction(stalePlacement, async () => assert.fail("no work")),
      expected);
    assert.equal(fleet.zero.calls.length + fleet.one.calls.length, 1, "no second attempt");
  }
});
