import assert from "node:assert/strict";
import { test } from "node:test";

import { recordingAgentInstancePort } from "./support/agent-instance-port.mjs";
import { capturingConsole } from "./support/capturing-console.mjs";
import { usageLimitHandoffCommand } from "../src/runtime-transport/agent-usage-limit-handoff.ts";
import { MessageAuthorityError } from "@xmatrix/db";
import { messageCall } from "../src/runtime-transport/runtime-messages.ts";
import { RuntimeAuthorityOperationError } from "../src/runtime-transport/runtime-operation-failure.ts";
import { capturingConsole } from "./support/capturing-console.mjs";

/**
 * An Instance whose provider account is used up reports `usage_limited`; the
 * Hub posts the turn-failure notice, holds the Instance's quota pool until the
 * reset, and posts `@<name>:<n>:handoff:@auto`. Moving the work is that
 * ordinary handoff's job, exactly as if somebody had typed it.
 */

function harness(hold = async () => ({ limitedUntil: "2026-10-01T13:00:00.000Z" })) {
  const { port, commands } = recordingAgentInstancePort({
    respond: (family, input) => family === "registration-usage-limit-hold" ? hold(input) : { sequence: 7 },
  });
  const session = {
    principal: {
      ownerUserId: "owner", spaceId: "space", channelId: "channel", agentId: "agent-1", agentName: "claude",
      runId: "run-1", executionKey: "execution-1", channelWriteAllowed: true,
    },
    run: { kind: "channel-instance", instanceId: "instance-1", channelId: "channel", channelInstanceId: "3" },
    presentation: { model: "claude-opus-5-5" },
  };
  return { commands, port, session };
}

const limited = {
  type: "agent_lifecycle", channelId: "channel", layer: "application", status: "failed",
  reason: "usage_limited", detail: "You've hit your limit · resets 1pm", resetsAt: "2026-10-01T13:00:00Z",
};

test("a usage-limited turn holds its pool, then only posts a handoff to @auto as the owner", async () => {
  const { commands, port, session } = harness();
  await port.execute(session, limited);
  assert.deepEqual(commands.map(command => command.family),
    ["append-message", "registration-usage-limit-hold", "append-message"]);
  const [notice, hold, handoff] = commands;
  assert.equal(notice.input.residual.appMetadata.xmatrixTurnFailure, true);
  assert.match(notice.input.body, /hit your limit/);
  assert.deepEqual(hold.input, { commandId: hold.input.commandId, actorUserId: "owner", channelId: "channel",
    sourceInstanceId: "instance-1", resetsAt: "2026-10-01T13:00:00Z" });
  // Nothing but the handoff itself: it is interpreted like any typed handoff.
  assert.equal(handoff.input.body, "@claude:3:handoff:@auto");
  assert.equal(handoff.input.residual.appMetadata.xmatrixUsageLimitHandoff, true);
  assert.equal(handoff.input.residual.appMetadata.xmatrixSystemNotice, true);
  assert.equal(handoff.input.residual.appMetadata.sourceMessageId, notice.input.messageId);
  // Posted as the owner, not under the source Run: the handoff may already be
  // stopping that Run, and its proof would then refuse the message. As the
  // owner it also reaches the same post-commit interpretation as a typed one.
  assert.deepEqual(handoff.input.principal, { kind: "user", id: "owner" });
  assert.equal(handoff.input.agentRunProof, undefined);
  assert.equal(handoff.input.senderSnapshot.userId, "owner");
  assert.equal(handoff.context.actorUserId, "owner");
});

test("a replayed usage-limit signal resolves to the same hold and handoff message", async () => {
  const first = harness();
  await first.port.execute(first.session, limited);
  const second = harness();
  await second.port.execute(second.session, limited);
  assert.deepEqual(second.commands.map(command => command.input.commandId ?? command.input.payload?.commandId),
    first.commands.map(command => command.input.commandId ?? command.input.payload?.commandId));
  assert.equal(second.commands[2].input.messageId, first.commands[2].input.messageId);
});

test("an ordinary turn failure never starts a handoff", async () => {
  const { commands, port, session } = harness();
  await port.execute(session, { ...limited, reason: "turn_failed", detail: "stream disconnected" });
  assert.deepEqual(commands.map(command => command.family), ["append-message"]);
});

test("a read-only or About session neither posts nor hands off", async () => {
  for (const change of [
    (session) => { session.principal.channelWriteAllowed = false; },
    (session) => { session.run.kind = "channel-about-session"; },
  ]) {
    const { commands, port, session } = harness();
    change(session);
    await port.execute(session, limited);
    assert.deepEqual(commands, []);
  }
});

test("a refused hold still hands the work off", async () => {
  const { commands, port, session } = harness(async () => {
    throw new RuntimeAuthorityOperationError("registration-usage-limit-hold", 409, { code: "forbidden" });
  });
  await port.execute(session, limited);
  assert.equal(commands.at(-1).input.body, "@claude:3:handoff:@auto");
});

/** The real append failure path: the message authority's refusal, classified by messageCall. */
function appendRefusedWith(code) {
  const { session } = harness();
  const { commands, port } = recordingAgentInstancePort({
    respond: (family) => family === "append-message"
      ? messageCall("append-message", async () => { throw new MessageAuthorityError(code, 409, "refused"); })
      : { sequence: 7 },
  });
  return { commands, port, session };
}

test("a turn-failure notice whose id is already committed is not an error (XMATRIX-HUB-66, XMATRIX-HUB-67)", async () => {
  for (const code of ["idempotency_conflict", "message_exists"]) {
    const { commands, port, session } = appendRefusedWith(code);
    const logged = await capturingConsole(() => port.execute(session, limited));
    assert.deepEqual(logged.error, [], code);
    assert.equal(logged.warn.length, 1, code);
    assert.equal(logged.warn[0][0], "xMatrix runtime authority rejection");
    assert.equal(logged.warn[0][1].status, 409);
    // The committed notice already started its own hold and handoff.
    assert.deepEqual(commands.map(command => command.family), ["append-message"], code);
  }
});

test("any other refused turn-failure notice is still reported as an error", async () => {
  const { commands, port, session } = appendRefusedWith("message_sender_unavailable");
  const logged = await capturingConsole(() => port.execute(session, limited));
  assert.deepEqual(logged.error.map(([message]) => message),
    ["xMatrix runtime authority rejection", "Agent turn-failure notice could not be committed"]);
  assert.deepEqual(logged.warn, []);
  assert.deepEqual(commands.map(command => command.family), ["append-message"]);
});

test("only an addressable Instance gets a handoff", () => {
  assert.equal(usageLimitHandoffCommand(" claude ", "3"), "@claude:3:handoff:@auto");
  assert.equal(usageLimitHandoffCommand("claude", undefined), undefined);
  assert.equal(usageLimitHandoffCommand("  ", "3"), undefined);
});
