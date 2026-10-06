const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { launchChoiceView, launchChoicePollInterval } = require("./first-message-launch-choice-state.ts");
const sent = "2026-10-02T00:00:00.000Z";
const at = (ms) => Date.parse(sent) + ms;
const { firstMessageDecisionWindow, harnessLaunchOption } = require("@xmatrix/protocol");
// The Hub's choice record as the decision window the card reads.
const record = (extra = {}, options = [harnessLaunchOption("claude"), harnessLaunchOption("codex")]) =>
  firstMessageDecisionWindow({ channelId: "c", messageId: "m", deadlineAt: "2026-10-02T00:00:03.000Z", ...extra }, options);

test("the author's three seconds start when Jev's reading reaches them, never by this device's clock", () => {
  const { launchChoiceRead } = require("./first-message-launch-choice-state.ts");
  // Before Jev has read the message the choice is open, without a countdown, while the Hub holds it open.
  assert.deepEqual(launchChoiceView(record({ open: true }), { sentAt: sent }, at(2_000)), { kind: "open" });
  assert.equal(launchChoiceRead(record({ open: true })), false);
  // Jev's reading appears at 5s: three whole seconds from there.
  const read = record({ open: true, recommendation: { start: true, harness: "codex" } });
  assert.equal(launchChoiceRead(read), true);
  assert.deepEqual(launchChoiceView(read, { sentAt: sent, seenAt: at(5_000) }, at(7_000)),
    { kind: "open", deadlineAt: at(8_000), recommended: "codex" });
  assert.deepEqual(launchChoiceView(read, { sentAt: sent, seenAt: at(5_000) }, at(8_000)), { kind: "reading", recommended: "codex" });
  // The Hub says closed: a reopened old conversation never counts down again, whatever this clock says.
  assert.deepEqual(launchChoiceView(record({ open: false, recommendation: { start: false } }), {}, at(-60_000)),
    { kind: "reading", recommended: null });
  // Before the Hub's record arrives, only the author's fresh message shows, until the hold limit.
  assert.deepEqual(launchChoiceView(undefined, { sentAt: sent }, at(9_000)), { kind: "open" });
  assert.deepEqual(launchChoiceView(undefined, { sentAt: sent }, at(30_000)), { kind: "hidden" });
  assert.deepEqual(launchChoiceView(undefined, {}, at(500)), { kind: "hidden" });
});

test("Jev's reading shows during the window and the decision settles the card", () => {
  assert.deepEqual(launchChoiceView(record({ open: true, recommendation: { start: true, harness: "codex" } }), {}, at(1_000)),
    { kind: "open", recommended: "codex" });
  assert.deepEqual(launchChoiceView(record({ open: false, recommendation: { start: false } }), {}, at(4_000)),
    { kind: "reading", recommended: null });
  assert.deepEqual(launchChoiceView(record({ choice: { start: false, by: "author", at: sent } }), {}, at(1_000)),
    { kind: "none", by: "author" });
  // A decided harness is summoned by its `@<harness>` reply, which shows the launch.
  const decided = launchChoiceView(record({ choice: { start: true, harness: "claude", by: "jev", at: sent } }), {}, at(5_000));
  assert.equal(decided.kind, "chosen");
  assert.equal(decided.option.displayName, "claude");
  assert.equal(decided.by, "jev");
  // Jev could not decide and nobody chose: nothing starts, and the card says why.
  assert.deepEqual(launchChoiceView(record({ open: false, failureCode: "registration_not_found" }), {}, at(4_000)),
    { kind: "none", by: "jev", failureCode: "registration_not_found" });
});

test("the window lists what the reader may start, plus whatever Jev or the author picked", () => {
  const window = record({ recommendation: { start: true, harness: "gemini" } }, [harnessLaunchOption("claude")]);
  assert.deepEqual(window.options.map(option => option.optionId), ["claude", "gemini"]);
  assert.equal(window.recommendation, "gemini");
  assert.equal(window.presentationRef, "launch-choice.v1");
  assert.ok(window.options.every(option => option.funding.kind === "owner-subscription" && option.iconRef));
  const chosen = record({ choice: { start: true, harness: "grok", by: "author", at: sent } }, []);
  assert.deepEqual(chosen.decision, { optionId: "grok", by: "author", at: sent });
  assert.equal(record({ recommendation: { start: false } }).recommendation, null);
});

test("only an open or undecided choice polls quickly", () => {
  assert.equal(launchChoicePollInterval([{ kind: "open", deadlineAt: 1 }]), 500);
  assert.equal(launchChoicePollInterval([{ kind: "reading" }]), 1_000);
  assert.equal(launchChoicePollInterval([{ kind: "none", by: "jev" }, { kind: "hidden" }]), undefined);
  assert.equal(launchChoicePollInterval([{ kind: "chosen", by: "author" }]), undefined);
});
