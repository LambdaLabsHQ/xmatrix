import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideProductAgentSwitch,
  orchestrateProductAgentControlCommands,
  parseProductAgentControlCommands,
} from "../src/product-agent-model-effort.ts";

/** The single-statement reading the older assertions are written against. */
const parseOne = (body) => parseProductAgentControlCommands(body)[0];

import {
  agentChannelMessageDeliveryIntent,
  channelMessageDeliveryIntent,
} from "../src/runtime-transport/channel-message-frame.ts";

function intent(body) {
  return agentChannelMessageDeliveryIntent({
    channelId: "channel-1", messageId: "control", sequence: 1, body,
    from: { kind: "user", label: "Owner" }, sentAt: "2026-10-18T00:00:00Z",
  }, { agentName: "claude", channelInstanceId: "1" });
}

function portWith(outcome) {
  const requests = [];
  const outcomes = [];
  return {
    requests,
    outcomes,
    async switchControl(input) {
      requests.push(input);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async recordOutcomes(_channelId, recorded) {
      outcomes.push(recorded);
    },
  };
}

test("model and effort commands keep the exact channel-instance address", () => {
  assert.deepEqual(parseOne("@claude:1 /model fable"), {
    kind: "model",
    target: "claude:1",
    value: "fable",
  });
  assert.deepEqual(parseOne("@codex:12 /effort high"), {
    kind: "effort",
    target: "codex:12",
    value: "high",
  });
  // Codex documents /reasoning for the same control.
  assert.deepEqual(parseOne("@codex:2 /reasoning low"), {
    kind: "effort",
    target: "codex:2",
    value: "low",
  });
  // A bare command asks what is on offer rather than switching to nothing.
  assert.deepEqual(parseOne("@claude:1 /model"), {
    kind: "model",
    target: "claude:1",
  });
});

test("prose that merely mentions a model is not a command", () => {
  assert.equal(parseOne("can you switch to fable"), undefined);
  assert.equal(parseOne("@claude:1 what model are you"), undefined);
  // A trailing argument list is not the single-token grammar the runtime accepts.
  assert.equal(parseOne("@claude:1 /model fable please"), undefined);
  assert.equal(parseOne("/model fable"), undefined);
});

test("a confirmed switch names the model the instance actually accepted", async () => {
  const port = portWith({ status: "switched", selected: "fable" });
  const result = await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:1 /model fable",
    port,
  });
  assert.deepEqual(port.requests, [{
    channelId: "channel-1",
    target: "claude:1",
    kind: "model",
    value: "fable",
  }]);
  assert.equal(result[0].outcome.status, "switched");
  // The answer is recorded on the statement, not posted as a message.
  assert.deepEqual(port.outcomes, [[{ kind: "model", target: "claude:1", status: "switched", selected: "fable" }]]);
});

test("a bare command lists the catalog and the current selection", async () => {
  const port = portWith({ status: "catalog", current: "opus", options: ["fable", "opus"] });
  await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:1 /model",
    port,
  });
  assert.equal(port.requests[0].value, undefined);
  assert.deepEqual(port.outcomes[0], [{ kind: "model", target: "claude:1", status: "catalog",
    options: ["fable", "opus"], current: "opus" }]);
});

test("a missing instance and a failed switch both report instead of going silent", async () => {
  const missing = portWith({ status: "no_instance" });
  await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:9 /effort high",
    port: missing,
  });
  assert.equal(missing.outcomes[0][0].status, "no_instance");

  const failed = portWith({ status: "error", message: "timed out." });
  await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:1 /model fable",
    port: failed,
  });
  assert.deepEqual(failed.outcomes[0][0], { kind: "model", target: "claude:1", status: "error", message: "timed out." });
});

test("a thrown port failure is narrated, not swallowed", async () => {
  const port = portWith(new Error("runtime unavailable"));
  const result = await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:1 /model fable",
    port,
  });
  assert.equal(result[0].outcome.status, "error");
  assert.equal(port.outcomes[0][0].message, "runtime unavailable");
});

test("non-commands never reach the port", async () => {
  const port = portWith({ status: "switched", selected: "fable" });
  const result = await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "just a normal message",
    port,
  });
  assert.deepEqual(result, []);
  assert.deepEqual(port.requests, []);
  assert.deepEqual(port.outcomes, []);
});

test("a control command delivers as context so it cannot burn an instance turn", () => {

  assert.equal(intent("@claude:1 /model fable"), "context");
  assert.equal(intent("@claude:1 /effort high"), "context");
  // Ordinary work must stay a task; only the command grammar is exempt.
  assert.equal(intent("@claude:1 please switch to fable"), "work");
  assert.equal(intent("ship it"), "work");
});

test("only Instance delivery is suppressed, never the Human or history read", () => {
  // The Hub executes the switch, so the addressed Instance must not also be
  // handed the text as work. Every other audience still reads it as an
  // ordinary message: the humans typed it and must see it in the transcript.
  for (const body of ["@claude:1 /model fable", "@claude:1 /effort high"]) {
    assert.equal(channelMessageDeliveryIntent({ body }), "work");
  }
});

test("one message carries several statements and answers with one receipt", async () => {
  const port = portWith({ status: "switched", selected: "fable" });
  const result = await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:1 /model fable\n@claude:1 /effort high",
    port,
  });
  assert.deepEqual(result.map((entry) => entry.kind), ["model", "effort"]);
  assert.deepEqual(port.requests.map((request) => request.kind), ["model", "effort"]);
  // A tag edit is one decision: one recording, not one per tag.
  assert.equal(port.outcomes.length, 1);
  // Each written statement gets its own result, in the order it was written.
  assert.deepEqual(port.outcomes[0], [
    { kind: "model", target: "claude:1", status: "switched", selected: "fable" },
    { kind: "effort", target: "claude:1", status: "switched", selected: "fable" },
  ]);
});

test("a statement that is not a command disqualifies the whole message", () => {
  // Executing half and delivering the other half as work would answer one
  // message twice.
  assert.deepEqual(
    parseProductAgentControlCommands("@claude:1 /model fable\nand then ship it"),
    [],
  );
  assert.equal(
    parseProductAgentControlCommands("@claude:1 /model fable\n@claude:1 /effort high").length,
    2,
  );
});

test("multi-statement control messages still deliver as context", () => {
  assert.equal(intent("@claude:1 /model fable\n@claude:1 /effort high"), "context");
  assert.equal(intent("@claude:1 /model fable\nand then ship it"), "work");
});

/**
 * A switch that cancels a running turn owes it a continuation. Hub decides it
 * and commits one instruction per Instance once every statement has landed,
 * worded by the Hub, rather than the Instance resuming itself.
 */
function continuationPort(outcomes) {
  const continuations = [];
  const port = {
    async switchControl(input) { return outcomes.shift()(input); },
    async recordOutcomes() {},
    async continueTurn(_channelId, input) { continuations.push(input); },
  };
  return { port, continuations };
}

test("the switches that cancelled a turn commit one continuation naming what was selected", async () => {
  const { port, continuations } = continuationPort([
    () => ({ status: "switched", selected: "fable", continuation: { instanceId: "instance-1", requestId: "switch-1" } }),
    () => ({ status: "switched", selected: "high" }),
  ]);
  await orchestrateProductAgentControlCommands({ channelId: "channel", body: "@claude:1 /model fable\n@claude:1 /effort high", port });
  assert.equal(continuations.length, 1);
  assert.equal(continuations[0].instanceId, "instance-1");
  assert.deepEqual(continuations[0].requestIds, ["switch-1"]);
  assert.match(continuations[0].body, /so that the switch to model `fable` and effort `high` took effect at once/u);
  assert.match(continuations[0].body, /no person interrupted or rejected anything/u);
});

test("a refused switch that cancelled the turn still continues it; one that cancelled nothing does not", async () => {
  const refused = continuationPort([
    () => ({ status: "error", message: "not offered", continuation: { instanceId: "instance-1", requestId: "switch-1" } }),
  ]);
  await orchestrateProductAgentControlCommands({ channelId: "channel", body: "@claude:1 /model nope", port: refused.port });
  assert.match(refused.continuations[0].body, /for a model or effort switch, which was not applied/u);
  const idle = continuationPort([() => ({ status: "switched", selected: "fable" })]);
  await orchestrateProductAgentControlCommands({ channelId: "channel", body: "@claude:1 /model fable", port: idle.port });
  assert.deepEqual(idle.continuations, []);
});

const NOW = Date.parse("2026-11-16T20:29:30Z");
const CATALOG = [
  { model: "claude-opus-5-5", description: "", efforts: [], isDefault: true },
  { model: "claude-fable-5-2", description: "", efforts: [], names: ["fable"], quotaScopes: ["Fable"] },
];
/** An account with weekly quota left whose Fable-only week is used up. */
const FABLE_USED_UP = {
  quotaSource: "provider_api", quotaObservedAt: "2026-11-16T20:29:00Z",
  quotaUsages: [{ label: "1w", percent: 63, resetAt: "2026-11-19T18:00:00Z" }],
  scopedQuotaUsages: [{ label: "1w", scope: "Fable", percent: 100, resetAt: "2026-11-19T18:00:00Z" }],
};
const running = (extra = {}) => ({ state: "running", agentName: "claude", machineName: "build-box",
  currentModel: "claude-opus-5-5", modelCatalog: CATALOG, reportedModels: [{ model: "claude-opus-5-5" }], ...extra });

function decide(command, target, outcome = { status: "switched", selected: command.value }) {
  const dispatched = [];
  return decideProductAgentSwitch({ command: { target: "claude:3", ...command }, target, now: NOW,
    dispatch: async (reportedModels) => { dispatched.push(reportedModels); return outcome; } })
    .then((result) => ({ result, dispatched }));
}

test("a model whose provider quota is used up is refused before its Instance is interrupted", async () => {
  const { result, dispatched } = await decide({ kind: "model", value: "fable" }, running({ usage: FABLE_USED_UP }));
  assert.deepEqual(result, { status: "error",
    message: "the provider quota for claude-fable-5-2 on build-box is used up until 2026-11-19 18:00 UTC. @claude:3 stays on claude-opus-5-5.",
    quotaExhausted: { model: "claude-fable-5-2", resetsAt: "2026-11-19T18:00:00.000Z", machineName: "build-box" } });
  assert.deepEqual(dispatched, []);
});

test("a used-up model names the Machines whose own reading leaves it quota", async () => {
  const reading = (percent) => ({ ...FABLE_USED_UP,
    scopedQuotaUsages: [{ label: "1w", scope: "Fable", percent, resetAt: "2026-11-19T18:00:00Z" }] });
  const { result } = await decide({ kind: "model", value: "fable" }, running({ usage: FABLE_USED_UP, harness: "claude",
    currentModel: "claude-sonnet-5-5",
    elsewhere: [{ machineName: "spent-box", usage: reading(100) }, { machineName: "fresh-box", usage: reading(6) },
      { machineName: "unread-box", usage: undefined }] }));
  assert.deepEqual(result.quotaExhausted, { model: "claude-fable-5-2", resetsAt: "2026-11-19T18:00:00.000Z",
    machineName: "build-box", available: ["claude-opus-5-5"], elsewhere: [{ machineName: "fresh-box", harness: "claude" }] });
});

test("a model with quota left is switched with the Instance row's catalog", async () => {
  const { result, dispatched } = await decide({ kind: "model", value: "claude-opus-5-5" }, running({ usage: FABLE_USED_UP }));
  assert.deepEqual(result, { status: "switched", selected: "claude-opus-5-5" });
  assert.deepEqual(dispatched, [[{ model: "claude-opus-5-5" }]]);
});

test("a provider's own quota refusal names the account and keeps the turn's continuation", async () => {
  const continuation = { instanceId: "channel-1:3", requestId: "request-1" };
  const { result } = await decide({ kind: "model", value: "fable" }, running(), { status: "error", continuation,
    message: "API error: 429 This request would exceed your account's rate limit. Please try again later · model not changed" });
  assert.deepEqual(result, { status: "error", continuation,
    message: "the provider account on build-box has no quota left for claude-fable-5-2, and gave no reset time. @claude:3 stays on claude-opus-5-5.",
    quotaExhausted: { model: "claude-fable-5-2", machineName: "build-box" } });
  // With the account read but not the refused model's own quota, a model
  // sharing its scope is not promised; one outside it is.
  const catalog = [...CATALOG, { model: "claude-fable-5-1", description: "", efforts: [], quotaScopes: ["Fable"] },
    { model: "claude-sonnet-5-5", description: "", efforts: [] }];
  const accountOnly = { ...FABLE_USED_UP, scopedQuotaUsages: [] };
  const unread = await decide({ kind: "model", value: "fable" }, running({ modelCatalog: catalog, usage: accountOnly }),
    { status: "error", message: "API error: 429 rate limit" });
  assert.deepEqual(unread.result.quotaExhausted.available, ["claude-sonnet-5-5"]);
});

test("an Instance no Runtime cell holds is named for what it is", async () => {
  const missing = { status: "no_instance" };
  const answer = async (state) => (await decide({ kind: "model", value: "fable" }, running({ state }), missing)).result;
  const message = async (state) => (await answer(state)).message;
  assert.deepEqual([(await answer("starting")).starting, (await answer("asleep")).starting], [true, undefined]);
  assert.equal(await message("starting"),
    "@claude:3 is still starting on build-box and did not come up while xMatrix waited. Send this again once it is running.");
  assert.equal(await message("running"),
    "@claude:3 is not connected to xMatrix right now on build-box and did not come back while xMatrix waited. Send this again once it is back.");
  assert.equal(await message("asleep"),
    "@claude:3 is asleep, so it has no session to switch. It wakes on its next message; send this again then.");
  assert.equal(await message("stopped"),
    "@claude:3 has stopped. Start it again with @claude:3:reborn, then send this again.");
  // No such Instance, or one whose row names another Agent, stays not found.
  assert.deepEqual((await decide({ kind: "model", value: "fable" }, undefined, missing)).result, missing);
  assert.deepEqual((await decide({ kind: "model", value: "fable" }, running({ agentName: "codex", usage: FABLE_USED_UP }), missing)).result, missing);
});

test("a listed catalog marks the models whose quota is used up", async () => {
  const catalog = { status: "catalog", current: "claude-opus-5-5", options: ["claude-opus-5-5", "claude-fable-5-2"] };
  assert.deepEqual((await decide({ kind: "model" }, running({ usage: FABLE_USED_UP }), catalog)).result,
    { ...catalog, usedUp: [{ option: "claude-fable-5-2", resetsAt: "2026-11-19T18:00:00.000Z" }] });
  assert.deepEqual((await decide({ kind: "model" }, running(), catalog)).result, catalog);
});

test("a statement to an Instance that is still starting waits for its first report and is applied then", async () => {
  const asked = [];
  const result = await decideProductAgentSwitch({ command: { kind: "model", target: "claude:3", value: "claude-opus-5-5" },
    target: running({ state: "starting" }), now: NOW,
    dispatch: async (_models, awaitStarting) => {
      asked.push(awaitStarting === true);
      return awaitStarting ? { status: "switched", selected: "claude-opus-5-5" } : { status: "no_instance" };
    } });
  assert.deepEqual([result, asked], [{ status: "switched", selected: "claude-opus-5-5" }, [false, true]]);
  // One being reborn or reconnecting (a Run, no connection) is waited for the same way; one asleep is not.
  const waits = async (state) => {
    const waited = [];
    await decideProductAgentSwitch({ command: { kind: "model", target: "claude:3", value: "claude-opus-5-5" },
      target: running({ state }), now: NOW,
      dispatch: async (_models, awaitStarting) => { waited.push(awaitStarting === true); return { status: "no_instance" }; } });
    return waited;
  };
  assert.deepEqual([await waits("running"), await waits("asleep")], [[false, true], [false]]);
});

test("a model written to a resting Instance is recorded for its wake, and a used-up one is still refused", async () => {
  const asleep = (extra = {}) => running({ state: "asleep", ...extra });
  const decideAsleep = (command, target, chooseOnWake, dispatch = async () => ({ status: "no_instance" })) =>
    decideProductAgentSwitch({ command: { target: "claude:3", ...command }, target, now: NOW, dispatch, chooseOnWake });
  const asked = [];
  assert.deepEqual(await decideAsleep({ kind: "model", value: "opus" }, asleep(),
    async (written) => { asked.push(written); return { selected: "claude-opus-5-5" }; }),
  { status: "switched", selected: "claude-opus-5-5", onWake: true });
  assert.deepEqual(asked, ["opus"]);
  // A model it cannot start on names the ones it can.
  assert.deepEqual(await decideAsleep({ kind: "model", value: "gpt" }, asleep(), async () => ({ offers: ["claude-opus-5-5"] })),
    { status: "error", message: "`gpt` is not one @claude:3 can start on. It can start on `claude-opus-5-5`." });
  // Used up: refused with its reset before anything is recorded.
  const refused = await decideAsleep({ kind: "model", value: "fable" }, asleep({ usage: FABLE_USED_UP }),
    async () => assert.fail("nothing to record"), async () => assert.fail("nothing to ask"));
  assert.match(refused.message, /^the provider quota for claude-fable-5-2 on build-box is used up until 2026-11-19 18:00 UTC\./u);
  // It woke meanwhile: it is asked as a live Instance, waiting for its report.
  const waited = [];
  assert.deepEqual(await decideAsleep({ kind: "model", value: "opus" }, asleep(), async () => undefined,
    async (_models, awaitStarting) => { waited.push(awaitStarting === true);
      return awaitStarting ? { status: "switched", selected: "claude-opus-5-5" } : { status: "no_instance" }; }),
  { status: "switched", selected: "claude-opus-5-5" });
  assert.deepEqual(waited, [false, true]);
  // Its models are listed from what it last reported; an effort still waits for it to wake.
  assert.deepEqual(await decideAsleep({ kind: "model" }, asleep({ usage: FABLE_USED_UP })),
    { status: "catalog", options: ["claude-opus-5-5", "claude-fable-5-2"], current: "claude-opus-5-5",
      usedUp: [{ option: "claude-fable-5-2", resetsAt: "2026-11-19T18:00:00.000Z" }] });
  assert.match((await decideAsleep({ kind: "effort", value: "high" }, asleep())).message, /is asleep/u);
});
