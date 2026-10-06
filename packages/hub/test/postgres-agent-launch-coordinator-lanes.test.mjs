import assert from "node:assert/strict";
import test from "node:test";
import { AgentLaunchCoordinatorLanes } from "../src/postgres-agent-launch-coordinator-lanes.ts";
import { RelayPostgresAgentLaunchCoordinatorService } from "../src/postgres-agent-launch-coordinator.ts";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const label = target => target ? `claim:${target.channelId}:${target.launchIds.join(",")}` : "sweep";
function lanes(overrides = () => ({})) {
  const events = [];
  const instance = new AgentLaunchCoordinatorLanes({
    claim: async target => { events.push(label(target)); return target ? 1 : 0; },
    schedule: async count => { events.push(`alarm:${count}`); },
    keepAlive: () => {},
    ...overrides(events),
  });
  return { events, instance };
}
const claims = events => events.filter(event => !event.startsWith("alarm"));

test("wakes that arrive during a pass merge into one later pass per Channel, and sweeps collapse into one", async () => {
  const gate = deferred();
  const { events, instance } = lanes(events => ({ claim: async target => {
    events.push(label(target)); if (target?.launchIds.includes("a")) await gate.promise; return 1;
  } }));
  const drained = instance.claim({ channelId: "c", launchIds: ["a"] });
  void instance.claim({ channelId: "d", launchIds: ["b"] });
  void instance.claim({ channelId: "d", launchIds: ["c"] });
  void instance.claim();
  void instance.claim();
  gate.resolve();
  await drained;
  assert.deepEqual(claims(events), ["claim:c:a", "claim:d:b,c", "sweep"]);
});

test("a hung pass frees its slot at the deadline and later wakes still run", async () => {
  const overruns = [];
  const { events, instance } = lanes(events => ({ passDeadlineMs: 20,
    onClaimOverrun: target => overruns.push(target.channelId),
    claim: async target => { events.push(label(target)); if (target.channelId === "hung") await new Promise(() => {}); return 1; } }));
  void instance.claim({ channelId: "hung", launchIds: ["a"] });
  await instance.claim({ channelId: "next", launchIds: ["b"] });
  assert.deepEqual(claims(events), ["claim:hung:a", "claim:next:b"]);
  assert.deepEqual(overruns, ["hung"]);
});

test("a failed claim still schedules the next sweep", async () => {
  const errors = [];
  const { events, instance } = lanes(() => ({ claim: async () => { throw new Error("postgres unavailable"); },
    onClaimError: error => errors.push(error.message) }));
  await instance.claim({ channelId: "c", launchIds: ["a"] });
  assert.deepEqual(events, ["alarm:0"]);
  assert.deepEqual(errors, ["postgres unavailable"]);
});

test("one overdue reconciliation step no longer holds its round and is skipped until it settles", async () => {
  const service = new RelayPostgresAgentLaunchCoordinatorService({}, 20);
  const hung = deferred();
  const stepMs = {};
  const warn = console.warn; console.warn = () => {};
  try {
    await service.boundedStep("reborn", () => hung.promise, stepMs);
    assert.ok(stepMs.reborn >= 15 && stepMs.reborn < 1_000);
    let ran = false;
    await service.boundedStep("reborn", async () => { ran = true; }, stepMs);
    assert.equal(ran, false, "the overdue step is not started twice");
    assert.equal(stepMs.reborn, -1);
    hung.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    await service.boundedStep("reborn", async () => { ran = true; }, stepMs);
    assert.equal(ran, true);
  } finally { console.warn = warn; }
});
