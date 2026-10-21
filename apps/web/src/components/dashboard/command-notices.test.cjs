const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { foldCommandNotices } = require("./command-notices.ts");
const { segmentMessageInteraction, controlView, stopView } = require("./mention-invocation-state.ts");
const { parseAgentControlInvocations } = require("@xmatrix/protocol");

const sentAt = "2026-10-21T21:08:00Z";
const human = (messageId, body, extra = {}) => ({ messageId, channelId: "c", body, sentAt,
  from: { kind: "user", label: "Daniel" }, ...extra });
const notice = (messageId, sourceMessageId, body, metadata = {}) => ({ messageId, channelId: "c", body, sentAt,
  from: { kind: "user", label: "xMatrix" }, metadata: { xmatrixSystemNotice: true, sourceMessageId, ...metadata } });

test("a switch's receipt and continuation fold into the statement that asked for them", () => {
  const outcomes = [{ kind: "effort", target: "claude:1", status: "switched", selected: "max" }];
  const { folded, noticesBySource } = foldCommandNotices([
    human("m1", "@claude:1 /effort max"),
    notice("r1", "m1", "Switched @claude:1 to `max`.", { controlOutcomes: outcomes }),
    notice("k1", "m1", "[xMatrix] xMatrix interrupted your previous turn", { xmatrixSwitchContinuation: { version: 1 } }),
  ]);
  assert.deepEqual([...folded].sort(), ["k1", "r1"]);
  assert.deepEqual(noticesBySource.get("m1").map(item => [item.messageId, item.controlOutcomes]), [["r1", outcomes]]);
});

test("a notice keeps its own row when its command is not on screen, edited, or not a command", () => {
  const { folded } = foldCommandNotices([
    notice("r1", "gone", "Switched @claude:1 to `max`."),
    human("m2", "@claude:1 /effort max", { editedAt: sentAt }),
    notice("r2", "m2", "Switched @claude:1 to `max`."),
    human("m3", "@claude please look"),
    notice("r3", "m3", "Retired syntax"),
  ]);
  assert.equal(folded.size, 0);
});

test("a refused reborn folds only the notice that names its address", () => {
  const { folded } = foldCommandNotices([
    human("m1", "@claude:1:reborn continue"),
    notice("r1", "m1", "xMatrix could not find @claude:1 to reborn."),
    notice("r2", "m1", "xMatrix could not find @claude:12 to reborn."),
  ]);
  assert.deepEqual([...folded], ["r1"]);
});

test("each statement claims its own span and outcome", () => {
  const body = "@claude:1 /model fable\n@claude:1 /effort";
  const controls = parseAgentControlInvocations(body);
  const outcomes = [{ kind: "model", target: "claude:1", status: "switched", selected: "fable" },
    { kind: "effort", target: "claude:1", status: "catalog", options: ["low", "max"], current: "max" }];
  const segments = segmentMessageInteraction(body, { controls,
    notices: [{ messageId: "r", body: "", sentAt, controlOutcomes: outcomes }] });
  const chips = segments.filter(segment => segment.presentationRef === "runtime-control.v1");
  assert.deepEqual(chips.map(chip => [chip.text, chip.outcome.status]),
    [["@claude:1 /model fable", "switched"], ["@claude:1 /effort", "catalog"]]);
  assert.equal(controlView(controls[0], outcomes[0], undefined, { fresh: false }).label, "Switched");
  assert.equal(controlView(controls[1], outcomes[1], undefined, { fresh: false }).label, "Options");
  assert.equal(controlView(controls[0], undefined, undefined, { fresh: true }).label, "Switching");
  assert.equal(controlView(controls[0], { kind: "model", target: "claude:9", status: "no_instance" }, undefined,
    { fresh: false }).label, "Not found");
});

test("a stop that fenced nothing reads the Hub's notice as its answer", () => {
  const missing = stopView([], { fresh: false, unavailable: false,
    notices: [{ messageId: "n", body: "xMatrix could not find a live instance for `@claude:3`.", sentAt, stopOutcome: "not_stopped" }] });
  assert.equal(missing.label, "Not stopped");
  assert.match(missing.detail, /could not find/u);
  const resting = stopView([], { fresh: false, unavailable: false,
    notices: [{ messageId: "n", body: "Stopped @claude:3. It was resting.", sentAt, stopOutcome: "stopped" }] });
  assert.equal(resting.label, "Stopped");
  assert.equal(resting.tone, "success");
});

test("a result the Hub recorded on the command is drawn there, and a live event applies to the held message", () => {
  const { commandResultHistoryMessage } = require("./channel-history.ts");
  const controls = [{ kind: "effort", target: "claude:1", status: "switched", selected: "max" }];
  const held = human("m1", "@claude:1 /effort max", { sequence: 1 });
  const answered = commandResultHistoryMessage([held], { messageId: "m1", annotationId: "a1", payload: { controls } });
  assert.deepEqual(answered.commandResult, { controls });
  const { noticesBySource, folded } = foldCommandNotices([answered]);
  assert.equal(folded.size, 0);
  assert.deepEqual(noticesBySource.get("m1").map(notice => notice.controlOutcomes), [controls]);
  assert.equal(commandResultHistoryMessage([held], { messageId: "other", annotationId: "a1", payload: {} }), undefined);
});
