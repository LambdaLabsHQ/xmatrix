import assert from "node:assert/strict";
import { test } from "node:test";

import { signedOutTurn } from "../src/agent-signed-out-turn.ts";
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
const summon = { sourceMessageId: "message-1", sourceMention: "@claude fix the build" };

test("a turn refused as signed out posts its sign-in, with the summon to send again while that is unanswered", async () => {
  const { port, commands } = recordingAgentInstancePort({ signedOutTurn: async () => ({ signedOut, summon }) });
  await port.execute(session, failed("harness_signed_out"));
  assert.deepEqual(commands.map(command => command.family), ["signed-out-turn", "append-message"]);
  const notice = commands[1].input.residual.appMetadata;
  assert.equal(notice.kind, "xmatrix.harness-signed-out.v1");
  assert.deepEqual(notice.signedOut, signedOut);
  assert.deepEqual({ sourceMessageId: notice.sourceMessageId, sourceMention: notice.sourceMention }, summon);

  // A later turn answers no summon: only the sign-in.
  const later = recordingAgentInstancePort({ signedOutTurn: async () => ({ signedOut }) });
  await later.port.execute(session, failed("harness_signed_out"));
  assert.equal(later.commands[1].input.residual.appMetadata.sourceMention, undefined);
});

test("any other turn failure reads nothing; an unreadable registration still posts the failure", async () => {
  const other = recordingAgentInstancePort({ signedOutTurn: async () => ({ signedOut }) });
  await other.port.execute(session, failed("turn_failed"));
  assert.deepEqual(other.commands.map(command => command.family), ["append-message"]);

  const unreadable = recordingAgentInstancePort({ signedOutTurn: async () => { throw new Error("offline"); } });
  const output = await capturingConsole(() => unreadable.port.execute(session, failed("harness_signed_out")));
  const notice = unreadable.commands.find(command => command.family === "append-message");
  assert.match(notice.input.body, /OAuth session expired/);
  assert.equal(notice.input.residual.appMetadata.kind, undefined);
  assert.match(String(output.error[0]?.[0]), /Signed-out harness could not be read/);
});

test("a Run that never answered its `@auto` summon hands the message to the next Agent and sends nothing again", async () => {
  const run = { runId: "run-1", channelId: "channel", ownerUserId: "owner" };
  const calls = [];
  const dependencies = (refused, handed) => ({
    read: async (runId, ownerUserId) => { calls.push(["read", runId, ownerUserId]); return refused; },
    fallback: async (_env, input) => { calls.push(["fallback", input.runId]); return handed; },
    handedOn: async (_env, input) => { calls.push(["handed", input.agentName, input.sourceMessageId]); },
  });
  // Another Agent took it: the notice offers the sign-in alone.
  assert.deepEqual(await signedOutTurn({}, run, dependencies({ signedOut, summon }, { agentName: "grok" })), { signedOut });
  assert.deepEqual(calls, [["read", "run-1", "owner"], ["fallback", "run-1"], ["handed", "grok", "message-1"]]);
  // Nothing else could take it (or it named this Agent): the summon is sent again once signed in.
  calls.length = 0;
  assert.deepEqual(await signedOutTurn({}, run, dependencies({ signedOut, summon }, undefined)), { signedOut, summon });
  assert.deepEqual(calls.map(call => call[0]), ["read", "fallback"]);
  // A Run that already answered, or that no summon started, moves no message.
  calls.length = 0;
  assert.deepEqual(await signedOutTurn({}, run, dependencies({ signedOut }, { agentName: "grok" })), { signedOut });
  assert.deepEqual(calls.map(call => call[0]), ["read"]);
  assert.equal(await signedOutTurn({}, run, dependencies(undefined, undefined)), undefined);
});
