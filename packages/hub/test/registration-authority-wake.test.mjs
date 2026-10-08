import assert from "node:assert/strict";
import test from "node:test";

import { wakeRegistrationChannels } from "../src/registration-authority-wake.ts";

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
test("an authority change names the registration re-check; a returning Machine also names its Launches", async () => {
  const bodies = [];
  const namespace = { idFromName: name => name, get: () => ({ fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return new Response(null, { status: 202 }); } }) };
  await wakeRegistrationChannels({ RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL: namespace }, database(["c1"]), { spaceId: "space" });
  await wakeRegistrationChannels({ RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL: namespace }, database(["c2"]),
    { ownerUserId: "owner", machineId: "machine" }, ["registrationStop", "launch"]);
  assert.deepEqual(bodies.map(body => [body.channelId, body.work]),
    [["c1", ["registrationStop"]], ["c2", ["registrationStop", "launch"]]]);
});
