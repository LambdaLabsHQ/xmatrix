import assert from "node:assert/strict";
import test from "node:test";
import { RelayRuntimeLive } from "../src/relay-runtime.ts";

const SCOPE = "channel:route-directory-reset";
const CELL = "user-owner";
const RESET = "Internal error in Durable Object storage caused object to be reset; reference = test";

function runtime(fetch) {
  const pending = [];
  const logged = [];
  const occupied = new Set([SCOPE]);
  const directory = {
    idFromName: (name) => name,
    get: () => ({ fetch }),
  };
  const object = Object.create(RelayRuntimeLive.prototype);
  Object.assign(object, {
    env: { RELAY_RUNTIME_ROUTE_DIRECTORY: directory },
    ctx: { waitUntil: (task) => pending.push(task) },
    productAdapter: { occupiedChannelIds: () => [...occupied] },
    productOccupiedScopes: new Set([SCOPE]),
  });
  return { object, pending, logged, occupied };
}

async function settle(fixture) {
  const original = console.error;
  console.error = (...args) => fixture.logged.push(args.map(String).join(" "));
  try {
    fixture.object.scheduleRouteDirectoryMutation("register", CELL, [SCOPE]);
    await Promise.all(fixture.pending);
  } finally {
    console.error = original;
  }
}

test("a route-directory storage reset is replayed once and keeps the synced scope", async () => {
  const calls = [];
  const fixture = runtime(async () => {
    calls.push("fetch");
    if (calls.length === 1) throw new Error(RESET);
    return new Response(JSON.stringify({ registered: 1 }), { status: 200 });
  });
  await settle(fixture);
  assert.deepEqual(calls, ["fetch", "fetch"]);
  assert.equal(fixture.object.productOccupiedScopes.has(SCOPE), true);
  assert.deepEqual(fixture.logged, []);
});

test("a second route-directory storage reset unsyncs the scope for the next refresh", async () => {
  const calls = [];
  const fixture = runtime(async () => {
    calls.push("fetch");
    throw new Error(RESET);
  });
  await settle(fixture);
  assert.equal(calls.length, 2);
  assert.equal(fixture.object.productOccupiedScopes.has(SCOPE), false);
  assert.equal(fixture.logged.length, 1);
  assert.match(fixture.logged[0], /route-directory register failed/u);
});

test("an answered route-directory rejection is not replayed", async () => {
  const calls = [];
  const fixture = runtime(async () => {
    calls.push("fetch");
    return new Response("no", { status: 500 });
  });
  await settle(fixture);
  assert.deepEqual(calls, ["fetch"]);
  assert.equal(fixture.object.productOccupiedScopes.has(SCOPE), false);
  assert.match(fixture.logged[0], /rejected with 500/u);
});
