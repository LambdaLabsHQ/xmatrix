import assert from "node:assert/strict";
import { test } from "node:test";

import { recordingAgentInstancePort } from "./support/agent-instance-port.mjs";

/**
 * A runtime reports facts about its own work with `channel_activity`; the Hub
 * writes the activity entry itself (docs/design/conversation-activity.md §3.2),
 * and neither send path lets a caller supply metadata only the Hub may write.
 */

function harness() {
  const { port, commands } = recordingAgentInstancePort({ respond: () => ({ sequence: 7 }) });
  const session = {
    principal: {
      ownerUserId: "owner", spaceId: "space", channelId: "channel", agentId: "agent-1",
      runId: "run-1", executionKey: "execution-1", channelWriteAllowed: true,
    },
    run: { kind: "channel-instance", instanceId: "instance-1", channelId: "channel" },
    presentation: { model: "claude-opus-5-5" },
  };
  return { commands, port, session };
}

test("a plan report becomes a Hub-written activity entry under the Run's proof", async () => {
  const { commands, port, session } = harness();
  const reply = await port.execute(session, {
    type: "channel_activity", requestId: "r-1", channelId: "channel",
    activity: { kind: "plan", completed: ["Run the e2e regression"], inProgress: "Open PR 2",
      steps: [{ text: "Run the e2e regression", status: "completed" },
        { text: "Open PR 2", status: "in_progress" }] },
  });
  assert.equal(reply.type, "channel_message_dispatched");
  assert.equal(reply.messageId, "activity:r-1");
  const [{ family, input }] = commands;
  assert.equal(family, "append-message");
  assert.equal(input.messageKind, "xmatrix.activity");
  assert.equal(input.body, "✓ Run the e2e regression · → Open PR 2");
  assert.deepEqual(input.principal, { kind: "agent", id: "agent-1" });
  assert.deepEqual(input.agentRunProof,
    { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" });
  assert.equal(input.residual.appMetadata.xmatrixProvenance, "activity");
  assert.equal(input.residual.appMetadata.xmatrixActivity.kind, "plan");
});

test("a malformed or padded report is refused before anything is written", async () => {
  const { commands, port, session } = harness();
  await assert.rejects(port.execute(session, {
    type: "channel_activity", channelId: "channel", activity: { kind: "plan", completed: [], steps: [] },
  }), (error) => error.failure?.code === "invalid_channel_activity");
  await assert.rejects(port.execute(session, {
    type: "channel_activity", channelId: "channel", body: "extra",
    activity: { kind: "pull_request", url: "https://github.com/a/b/pull/1" },
  }), (error) => error.failure?.code === "invalid_agent_message_fields");
  assert.equal(commands.length, 0);
});

test("a Channel About session cannot write activity", async () => {
  const { commands, port, session } = harness();
  session.run.kind = "channel-about-session";
  await assert.rejects(port.execute(session, {
    type: "channel_activity", channelId: "channel",
    activity: { kind: "pull_request", url: "https://github.com/a/b/pull/1" },
  }), (error) => error.failure?.code === "agent_read_only_session");
  assert.equal(commands.length, 0);
});

test("an ordinary socket message keeps caller metadata but never Hub-only keys", async () => {
  const { commands, port, session } = harness();
  await port.execute(session, {
    type: "channel_message", requestId: "r-2", channelId: "channel", body: "hello",
    metadata: { kind: "xmatrix.questionnaire.v1", xmatrixProvenance: "system_fact",
      xmatrixActivity: { kind: "plan" }, crossChannelReply: { sourceChannelId: "elsewhere" } },
  });
  const [{ input }] = commands;
  assert.equal(input.messageKind, undefined);
  assert.deepEqual(input.residual.appMetadata, { kind: "xmatrix.questionnaire.v1" });
});

test("a Hub that accepts activity says so when an Instance connects", async () => {
  const { AGENT_INSTANCE_HUB_CAPABILITIES } = await import(
    "../src/runtime-transport/postgres-agent-instance-port.ts");
  assert.deepEqual([...AGENT_INSTANCE_HUB_CAPABILITIES], ["channel_activity"]);
});
