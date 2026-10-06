import assert from "node:assert/strict";
import { test } from "node:test";
import { routingModelCatalogObservation } from "@xmatrix/protocol";

import { recordingAgentInstancePort } from "./support/agent-instance-port.mjs";
import {
  agentMessagePresentation,
} from "../src/runtime-transport/agent-instance-presentation.ts";

/** The live session of Instance "instance" in "channel", presenting `model`. */
function instanceSession(model, run = {}) {
  return {
    principal: { ownerUserId: "owner", spaceId: "space", channelId: "channel" },
    run: { kind: "channel-instance", instanceId: "instance", ...run },
    presentation: { model },
  };
}

test("model catalog reports reach routing persistence without heartbeat refresh or message-header leakage", async () => {
  const { port, commands } = recordingAgentInstancePort();
  const session = instanceSession("actual-model");
  const models = [{ id: "actual-model", model: "actual-model", displayName: "Actual model",
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "More reasoning" }] }];
  await port.execute(session, { type: "presence_update", models });
  const first = commands[0].input.presentation;
  assert.deepEqual(first.models, models);
  assert.ok(Number.isFinite(Date.parse(first.modelsObservedAt)));
  assert.equal(agentMessagePresentation(first).models, undefined);
  assert.equal(agentMessagePresentation(first).modelsObservedAt, undefined);
  const now = Date.now();
  const catalog = routingModelCatalogObservation(first.models, first.modelsObservedAt, now);
  assert.equal(catalog.value[0].model, "actual-model");
  assert.equal(catalog.value[0].efforts[0].value, "high");
  session.presentation = first;
  await port.execute(session, { type: "presence_update" });
  assert.equal(commands.length, 1, "an unrelated heartbeat must not renew the catalog timestamp");
  const changed = [...models, { id: "second-model", model: "second-model" }];
  await port.execute(session, { type: "presence_update", models: changed });
  assert.equal(commands.length, 2, "catalog-only changes must invalidate the persistence digest");
  assert.equal(commands[1].input.presentation.models[1].model, "second-model");
  session.presentation = commands[1].input.presentation;
  await port.execute(session, { type: "presence_update", models: [] });
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[2].input.presentation.models, []);
  assert.equal(commands[2].input.presentation.modelsObservedAt, undefined);
});

test("provider quota reaches the durable instance command, including quota-only changes", async () => {
  const { port, commands } = recordingAgentInstancePort();
  const session = instanceSession("test-model");
  const usage = { quotaSource: "provider_api", quotaObservedAt: "2026-09-21T18:30:00Z",
    quotaUsages: [{ label: "1w", percent: 100, resetAt: "2026-09-26T11:55:12Z" }] };
  await port.execute(session, { type: "presence_update", usage });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].input.kind, "instance_presentation");
  assert.deepEqual(commands[0].input.presentation.usage, usage);
  const recovered = { ...usage, quotaObservedAt: "2026-09-21T18:31:00Z",
    quotaUsages: [{ ...usage.quotaUsages[0], percent: 10 }] };
  await port.execute(session, { type: "presence_update", usage: recovered });
  assert.equal(commands.length, 2, "quota changes must invalidate the persistence digest");
  assert.deepEqual(commands[1].input.presentation.usage, recovered);
  await port.execute(session, { type: "presence_update", usage: { ...recovered, totalTokens: 999 } });
  assert.equal(commands.length, 3, "token-only changes persist Instance accounting with the unchanged observation");
  assert.equal(commands[2].input.presentation.usage.totalTokens, 999);
  assert.equal(commands[1].input.presentation.usage.totalTokens, undefined);
});

test("the live status reaches the durable row with the presentation, once per change and again after a reconnect", async () => {
  const { port, commands } = recordingAgentInstancePort({
    signals: { async publish() {}, async connected() {}, async disconnected() {} },
  });
  const session = instanceSession("test-model", { instanceStatus: "online" });
  await port.execute(session, { type: "presence_update", status: "busy" });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].input.status, "busy");
  assert.equal(commands[0].input.presentation.status, undefined, "status stays out of the message-header snapshot");
  await port.execute(session, { type: "presence_update", status: "busy" });
  assert.equal(commands.length, 1, "an unchanged status is not rewritten");
  session.run.instanceStatus = "busy";
  await port.execute(session, { type: "presence_update", activity: "Reading files" });
  assert.equal(commands.length, 1, "a frame without a status keeps the session's status");
  await port.execute(session, { type: "presence_update", status: "idle" });
  assert.equal(commands.length, 2);
  assert.equal(commands[1].input.status, "idle");
  // The connect wrote `online` to the row; the replayed presence must land again.
  await port.connected(session, async () => {});
  await port.execute(session, { type: "presence_update", status: "idle" });
  assert.equal(commands.length, 3);
  assert.equal(commands[2].input.status, "idle");
  await port.execute(session, { type: "presence_update", status: "offline" });
  assert.equal(commands.at(-1).input.status, "busy", "a non-live frame status falls back to the session's live status");
});
