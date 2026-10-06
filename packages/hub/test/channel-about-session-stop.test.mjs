import assert from "node:assert/strict";
import { test } from "node:test";

import { stopChannelAboutSessions } from "../src/channel-about-session-stop.ts";

const target = {
  runId: "ch-1:about#8", channelId: "ch-1", sessionId: "ch-1:about#8",
  machineOwnerUserId: "user-1", machineId: "machine:1", hostId: "Workstation", executionKey: "exec-8",
};

/** Machine commands as the store keeps them: an id is issued once, and its daemon may fail it. */
function machineCommands() {
  const issued = new Map();
  return {
    issued,
    createPort: () => ({
      async issueStop(_target, controlId, reason) {
        const prior = issued.get(controlId);
        if (prior && prior.reason !== reason) throw new Error("Machine command id was reused");
        if (!prior) issued.set(controlId, { reason, status: "pending" });
      },
    }),
  };
}

test("a Channel About stop its daemon failed is issued again by the next trigger (XMATRIX-HUB-4T)", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const store = machineCommands();

  await stopChannelAboutSessions({}, [target], "Channel About summary saved", "summary", store.createPort);
  const [first] = store.issued.keys();
  // Windows: "failed to terminate daemon-owned process tree … process ancestry changed during stop".
  store.issued.get(first).status = "failed";

  await stopChannelAboutSessions({}, [target], "Channel About session finished its turn", "about:trigger-2",
    store.createPort);
  await stopChannelAboutSessions({}, [target], "Channel About session finished its turn", "about:trigger-2",
    store.createPort);

  assert.equal(errors.mock.callCount(), 0, "no stop was refused");
  assert.deepEqual([...store.issued.values()].map(command => command.status), ["failed", "pending"],
    "the next trigger queued one new stop; repeating that trigger replays it");
});
