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
