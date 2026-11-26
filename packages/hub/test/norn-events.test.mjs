import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "@xmatrix/protocol";
import { eventsStream, isNornStream } from "../src/norn-host.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const load = await compileCommonJsSourceModule(new URL("../src/norn-events.ts", import.meta.url));

const sentryStream = {
  type: "source",
  kind: "stream",
  name: "Events.events",
  args: [{ type: "variant", name: "EventKind", args: [{ type: "string", value: "sentry" }, { type: "string", value: "issue.created" }] }],
  labels: { source: { type: "string", value: "sentry:demo-app" } },
};

function harness({ programs, stepResult, deliverError } = {}) {
  const wakes = [];
  const branchSyncs = [];
  const enqueued = [];
  const delivered = [];
  class FakeRepository {
    async deliverEvent(scope, step) {
      delivered.push({ scope, step });
      if (deliverError) throw deliverError;
      return stepResult;
    }
  }
  const { occurNornEvent } = load(name => ({
    "@xmatrix/db": {
      enqueueNornEventDeliveries: async (_db, input) => { enqueued.push(input); return input.deliveries.length; },
      PostgresNornProgramRepository: FakeRepository,
      readWaitingNornPrograms: async (_db, input) => (input.afterProgramId ? [] : programs),
    },
    "@xmatrix/protocol": { sha256Hex },
    "./agent-launch-coordinator-wake": {
      wakeAgentLaunchCoordinator: async (_env, channelId, steps) => { wakes.push({ channelId, steps }); },
    },
    "./app-connectors": { githubRepositoryDelegated: async () => true },
    "./apps": { findAppConnection: async () => null },
    "./norn-branches": {
      ensureAndWakeNornBranches: async (_env, input) => { branchSyncs.push(input); },
    },
    "./norn-host": {
      isNornStream,
      nornStep: (_act, occurred) => ({ occurred }),
    },
    "./postgres-authority-fleet": {
      createPostgresAuthorityFleet: () => ({ physicalShards: [{ shardId: "shard-1", database: {} }] }),
    },
    "./postgres-message-authority": {
      postgresMessageRoute: async () => ({ spaceId: "space-1", channelId: "prog-chan" }),
    },
  })[name]);
  return { occurNornEvent, wakes, branchSyncs, enqueued, delivered };
}

test("occurNornEvent wakes branch conversations returned by immediate deliverEvent", async () => {
  const branch = { key: "services:page-target", label: "page-target", scope: "loop:services/round:0", channelId: "branch-chan-1" };
  const h = harness({
    programs: [{
      spaceId: "space-1",
      channelId: "prog-chan",
      programId: "prog-1",
      pageId: "page-host",
      pageName: "health",
      authorityUserId: "user-1",
      waits: [sentryStream],
    }],
    stepResult: { status: "running", branches: [branch], wakeChannels: ["branch-chan-1"] },
  });

  const heard = await h.occurNornEvent({}, {
    id: "sentry:evt-1",
    spaceId: "space-1",
    what: "Issue 42 created",
    matches: eventsStream("sentry", "issue.created", "sentry:demo-app"),
  });

  assert.equal(heard, 1);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.wakes.length, 0);
  assert.deepEqual(h.branchSyncs, [{
    spaceId: "space-1",
    pageId: "page-host",
    pageName: "health",
    programChannelId: "prog-chan",
    authorityUserId: "user-1",
    branches: [branch],
    wakeChannels: ["prog-chan", "branch-chan-1"],
  }]);
});

test("occurNornEvent falls back to waking the program conversation when no branch changes or delivery defers", async () => {
  const program = {
    spaceId: "space-1",
    channelId: "prog-chan",
    programId: "prog-1",
    pageId: null,
    pageName: null,
    authorityUserId: "user-1",
    waits: [sentryStream],
  };

  const plain = harness({ programs: [program], stepResult: { status: "running", wakeChannels: ["prog-chan"] } });
  assert.equal(await plain.occurNornEvent({}, {
    id: "sentry:evt-2",
    spaceId: "space-1",
    what: "Issue 43 created",
    matches: eventsStream("sentry", "issue.created", "sentry:demo-app"),
  }), 1);
  assert.equal(plain.branchSyncs.length, 0);
  assert.deepEqual(plain.wakes, [{ channelId: "prog-chan", steps: ["norn"] }]);

  const deferred = harness({ programs: [program], deliverError: new Error("lock timeout") });
  assert.equal(await deferred.occurNornEvent({}, {
    id: "sentry:evt-3",
    spaceId: "space-1",
    what: "Issue 44 created",
    matches: eventsStream("sentry", "issue.created", "sentry:demo-app"),
  }), 0);
  assert.equal(deferred.branchSyncs.length, 0);
  assert.deepEqual(deferred.wakes, [{ channelId: "prog-chan", steps: ["norn"] }]);
});
