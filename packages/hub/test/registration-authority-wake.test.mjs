import assert from "node:assert/strict";
import test from "node:test";

import { wakeMachineChannels, wakeRegistrationChannels } from "../src/registration-authority-wake.ts";

const database = channelIds => ({ transaction: async (_context, work) =>
  work({ query: async () => channelIds.map(channel_id => ({ channel_id })) }) });
const channels = reply => ({ idFromName: name => name, get: name => ({ fetch: async () => reply(name) }) });

test("every affected Channel is told, and a Channel that cannot be told is a retryable 503", async () => {
  const told = [];
  assert.equal(await wakeRegistrationChannels({ RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL: channels(name => {
    told.push(name); return new Response(null, { status: 202 });
  }) }, database(["c1", "c2"]), { spaceId: "space" }), 2);
  assert.deepEqual(told.sort(), ["c1", "c2"]);

  for (const reply of [() => new Response(null, { status: 500 }), () => { throw new Error("coordinator reset"); }]) {
    await assert.rejects(wakeRegistrationChannels({ RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL: channels(name =>
      name === "c2" ? reply() : new Response(null, { status: 202 })) }, database(["c1", "c2"]), { spaceId: "space" }),
    error => error.status === 503 && error.retryable === true && error.code === "agent_launch_handover_unavailable");
  }
});

// A wake names the work it may have moved, so the Channel's pass runs that and
// whatever is due — not every step (2026-10-08: woken passes ran ~15
// transactions each).
function recordingChannels(bodies) {
  return { idFromName: name => name, get: () => ({ fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return new Response(null, { status: 202 }); } }) };
}

test("an authority change names the registration re-check", async () => {
  const bodies = [];
  await wakeRegistrationChannels({ RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL: recordingChannels(bodies) }, database(["c1"]),
    { spaceId: "space" });
  assert.deepEqual(bodies.map(body => [body.channelId, body.work]), [["c1", ["registrationStop"]]]);
});

// 2026-10-09: every reconnect woke each Channel with a Run on the Machine into
// a full registration re-check, about eight transactions apiece.
test("a returning Machine tells only the Channels whose work waited on it, with that work and its shard", async () => {
  const bodies = [], asked = [];
  const shard = (shardId, rows) => ({ shardId, database: { transaction: async (_context, work) => work({
    query: async ({ values }) => { asked.push([shardId, ...values]); return rows; } }) } });
  const woken = await wakeMachineChannels({ RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL: recordingChannels(bodies) },
    { ownerUserId: "owner", machineId: "machine" }, [
      shard("shard-0", [{ channel_id: "queued", work: "launch" }, { channel_id: "both", work: "launch" },
        { channel_id: "both", work: "registrationStop" }]),
      shard("shard-1", [{ channel_id: "parked", work: "registrationStop" }]),
    ]);
  assert.equal(woken, 3);
  assert.deepEqual(asked, [["shard-0", "owner", "machine"], ["shard-1", "owner", "machine"]]);
  assert.deepEqual(bodies.map(body => [body.channelId, body.shardId, body.work]).sort(), [
    ["both", "shard-0", ["launch", "registrationStop"]],
    ["parked", "shard-1", ["registrationStop"]],
    ["queued", "shard-0", ["launch"]],
  ]);
  bodies.length = 0;
  assert.equal(await wakeMachineChannels({ RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL: recordingChannels(bodies) },
    { ownerUserId: "owner", machineId: "idle" }, [shard("shard-0", [])]), 0);
  assert.deepEqual(bodies, [], "nothing waited on the Machine, so no Channel is woken");
});
