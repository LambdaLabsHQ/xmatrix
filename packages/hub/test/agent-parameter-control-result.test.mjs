import assert from "node:assert/strict";
import { test } from "node:test";

import { channelInstanceSession, recordingAgentInstancePort } from "./support/agent-instance-port.mjs";
import { parameterControlNotice } from "../src/runtime-transport/postgres-agent-instance-port.ts";

/**
 * An Instance applies a `/config` or `/fast` control and reports the facts:
 * the parameter, its value now, its choices or the original error. Hub words
 * the notice and posts it as its own fact replying to the control, rather than
 * the Instance posting prose as its speech.
 */
const session = channelInstanceSession();
const result = { type: "agent_parameter_control_result", channelId: "channel", sourceMessageId: "control-1",
  parameter: "fast", action: "toggle", current: "on", choices: ["on", "off"] };

test("Hub posts the control's outcome as its own fact, once, replying to the control", async () => {
  const { port, commands } = recordingAgentInstancePort();
  await port.execute(session, result);
  const [notice] = commands;
  assert.equal(notice.family, "append-message");
  assert.equal(notice.input.body, "Set `fast` to `on` for codex:2.");
  assert.equal(notice.input.messageKind, "xmatrix.system.parameter-control", "a Hub fact, not the owner's speech");
  assert.equal(notice.input.residual.replyToMessageId, "control-1");
  assert.equal(notice.input.residual.appMetadata.xmatrixProvenance, "system_fact");
  const again = recordingAgentInstancePort();
  await again.port.execute(session, result);
  assert.equal(again.commands[0].input.messageId, notice.input.messageId, "a resent result keeps its notice");
});

test("a query, a provider note and a refusal read from the facts, with the original error", () => {
  assert.equal(parameterControlNotice("codex:2", { parameter: "fast", action: "query", current: "off",
    choices: ["on", "off"], notice: "cooldown" }), "codex:2 `fast`: `off` (cooldown). Choices: on, off.");
  assert.equal(parameterControlNotice("codex:2", { parameter: "speed", action: "select",
    error: "Harness parameter 'speed' does not support 'warp'" }),
    "Could not change `speed` for codex:2: Harness parameter 'speed' does not support 'warp'");
  assert.equal(parameterControlNotice("codex:2", { action: "query", error: "Use /config <parameter> [value]" }),
    "Could not read a parameter for codex:2: Use /config <parameter> [value]");
  assert.doesNotMatch(parameterControlNotice("@auto", { action: "select", error: "ask @auto" }), /[@＠]/u);
});

test("a result for another channel or from a read-only session is refused", async () => {
  const { port } = recordingAgentInstancePort();
  await assert.rejects(port.execute(session, { ...result, channelId: "elsewhere" }));
  await assert.rejects(port.execute({ ...session, principal: { ...session.principal, channelWriteAllowed: false } }, result));
});
