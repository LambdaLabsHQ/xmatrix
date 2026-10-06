import { assertDeliveredCountContract } from "./support/machine-daemon-port.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyMachineDaemonWakeResult,
  machineDaemonWakeFanOut,
  wakeCommittedPostgresMachineDaemonIssue,
} from "../src/relay-authority-machine-daemon-wake.ts";
import {
  machineDaemonDeliverable,
} from "../src/runtime-transport/machine-daemon-deliverable.ts";

const ISSUE = { action: "issue", ownerUserId: "user-1", machineId: "machine-1", hostId: "host-1" };

function wakeThrough(fetcher) {
  return wakeCommittedPostgresMachineDaemonIssue(() => fetcher, ISSUE, {});
}

function recordingWakeFetcher(reply) {
  const fetches = [];
  return { fetches, fetcher: { async fetch(request) { fetches.push(request); return Response.json(reply); } } };
}

test("PostgreSQL issue_batch posts one awaited reverse wake", async () => {
  const { fetches, fetcher } = recordingWakeFetcher({ matched: 1, delivered: 1, owners: 1, healed: false });
  const result = await wakeCommittedPostgresMachineDaemonIssue(() => fetcher, {
    action: "issue_batch", ownerUserId: "user-1", machineId: "machine-1", hostId: "host-1",
  }, {});
  assert.equal(fetches.length, 1);
  assert.deepEqual(await fetches[0].json(), {
    ownerUserId: "user-1", machineId: "machine-1", hostId: "host-1",
  });
  assert.equal(result.deliverable, true);
});

test("PostgreSQL skipWake does not post a reverse wake", async () => {
  const { fetches, fetcher } = recordingWakeFetcher({ matched: 1, delivered: 1, owners: 1 });
  const result = await wakeCommittedPostgresMachineDaemonIssue(() => fetcher, { ...ISSUE, skipWake: true }, {});
  assert.equal(result, undefined);
  assert.equal(fetches.length, 0);
});

test("wake posts exact claim route and reports deliverability", async () => {
  const { fetches, fetcher } = recordingWakeFetcher({ matched: 1, delivered: 2, owners: 1, healed: false });
  const result = await wakeThrough(fetcher);
  assert.equal(fetches.length, 1);
  assert.equal(
    fetches[0].url,
    "https://relay-runtime/internal/product-control/machine-daemon-claim",
  );
  assert.equal(fetches[0].method, "POST");
  assert.equal(fetches[0].headers.get("content-type"), "application/json");
  assert.deepEqual(await fetches[0].json(), {
    ownerUserId: "user-1",
    machineId: "machine-1",
    hostId: "host-1",
  });
  assert.equal(result.delivered, 2);
  assert.equal(result.deliverable, true);
});

for (const { name, fetch, warning, detail } of [
  {
    name: "wake logs unavailable status without throwing",
    async fetch() {
      return new Response(null, { status: 503 });
    },
    warning: "Machine Daemon issue wake was unavailable",
    detail: { status: 503 },
  },
  {
    name: "wake logs thrown network error without rethrowing",
    async fetch() {
      throw new Error("runtime unreachable");
    },
    warning: "Machine Daemon issue wake failed",
    detail: { error: "runtime unreachable" },
  },
]) {
  test(name, async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args);
    };
    try {
      assert.deepEqual(await wakeThrough({ fetch }), emptyMachineDaemonWakeResult());
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], warning);
    assert.deepEqual(warnings[0][1], {
      ownerUserId: "user-1",
      machineId: "machine-1",
      hostId: "host-1",
      ...detail,
    });
  });
}

test("delivered count is the only live fact", () => {
  assertDeliveredCountContract(machineDaemonDeliverable);
});

test("a wake reaches the daemon in whichever Runtime cell holds its socket", async () => {
  const bodies = [];
  const cell = (payload, ok = true) => ({
    async fetch(request) {
      bodies.push(await request.json());
      return ok ? Response.json(payload) : new Response("down", { status: 503 });
    },
  });
  const fanOut = machineDaemonWakeFanOut([
    cell({ matched: 0, delivered: 0, owners: 0 }),
    cell({ matched: 1, delivered: 1, owners: 1, healed: true }),
    cell({}, false),
  ]);
  const result = await wakeThrough(fanOut);
  assert.deepEqual(result, {
    matched: 1, delivered: 1, owners: 1, healed: true, deliverable: true,
  });
  assert.equal(bodies.length, 3, "every cell receives the full wake route");
  assert.ok(bodies.every((body) => body.ownerUserId === "user-1" && body.machineId === "machine-1"));
  const unreachable = await machineDaemonWakeFanOut([cell({}, false)])
    .fetch(new Request("https://relay-runtime/wake", { method: "POST" }));
  assert.equal(unreachable.status, 503);
});
