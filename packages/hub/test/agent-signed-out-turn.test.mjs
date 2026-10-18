import assert from "node:assert/strict";
import { test } from "node:test";

import { recordingAgentInstancePort } from "./support/agent-instance-port.mjs";
import { capturingConsole } from "./support/capturing-console.mjs";

const session = {
  principal: { ownerUserId: "owner", spaceId: "space", channelId: "channel", agentId: "agent-1", agentName: "claude",
    runId: "run-1", executionKey: "execution-1" },
  run: { instanceId: "instance-1", channelId: "channel", channelInstanceId: "1" },
  presentation: {},
};
const failed = (reason) => ({ type: "agent_lifecycle", channelId: "channel", layer: "application", status: "failed",
  reason, detail: "Failed to authenticate: OAuth session expired and could not be refreshed" });
const signedOut = { harness: "claude", program: "Claude Code", machineId: "machine:mac", machineName: "mac-mini" };

test("a turn refused as signed out is recorded on its Run and its notice carries the sign-in", async () => {
  const { port, commands } = recordingAgentInstancePort({ recordSignedOut: async () => signedOut });
  await port.execute(session, failed("harness_signed_out"));
  assert.deepEqual(commands.map(command => command.family), ["record-signed-out", "append-message"]);
  assert.equal(commands[0].input, "run-1");
  assert.deepEqual(commands[1].input.residual.appMetadata.signedOut, signedOut);
  assert.equal(commands[1].input.residual.appMetadata.kind, "xmatrix.harness-signed-out.v1");
});

test("any other turn failure records nothing; an unreadable registration still posts the failure", async () => {
  const other = recordingAgentInstancePort({ recordSignedOut: async () => signedOut });
  await other.port.execute(session, failed("turn_failed"));
  assert.deepEqual(other.commands.map(command => command.family), ["append-message"]);

  const unreadable = recordingAgentInstancePort({ recordSignedOut: async () => { throw new Error("offline"); } });
  const output = await capturingConsole(() => unreadable.port.execute(session, failed("harness_signed_out")));
  const notice = unreadable.commands.find(command => command.family === "append-message");
  assert.match(notice.input.body, /OAuth session expired/);
  assert.equal(notice.input.residual.appMetadata.kind, undefined);
  assert.match(String(output.error[0]?.[0]), /Signed-out harness could not be read/);
});
