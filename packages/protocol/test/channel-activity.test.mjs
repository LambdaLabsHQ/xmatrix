import assert from "node:assert/strict";
import test from "node:test";
import {
  callerMessageMetadata,
  ChannelActivityInvalid,
  channelActivityLine,
  channelActivityOf,
  normalizeChannelActivity,
  supersededByOf,
} from "../dist/channel-activity.js";

const plan = {
  kind: "plan",
  completed: ["Run e2e regression"],
  inProgress: "Open PR 2",
  steps: [
    { text: "Run e2e regression", status: "completed" },
    { text: "Open PR 2", status: "in_progress" },
    { text: "Write the CLI", status: "pending" },
  ],
};

test("a plan report reads back exactly as validated and renders one line", () => {
  assert.deepEqual(normalizeChannelActivity(plan), plan);
  assert.equal(channelActivityLine(plan), "✓ Run e2e regression · → Open PR 2");
  const fresh = normalizeChannelActivity({ kind: "plan", completed: [], steps: plan.steps });
  assert.equal(channelActivityLine(fresh), "Plan: 3 steps");
});

test("step titles are one bounded line and never an address", () => {
  const long = "x".repeat(500);
  const normalized = normalizeChannelActivity({ kind: "plan", completed: [`  ping\n@claude:2  ${long}`], steps: [] });
  assert.equal([...normalized.completed[0]].length, 200);
  assert.ok(normalized.completed[0].startsWith("ping @claude:2 x"));
  const line = channelActivityLine({ kind: "plan", completed: ["Reply to @alice and ＠bob"], steps: [] });
  assert.equal(line, "✓ Reply to alice and bob");
  assert.doesNotMatch(line, /[@＠]/u);
});

test("malformed reports are refused rather than trimmed into something else", () => {
  const refused = [
    null, [], "plan", { kind: "note" },
    { kind: "plan", completed: [], steps: [] },
    { ...plan, extra: true },
    { ...plan, steps: [{ text: "a", status: "done" }] },
    { ...plan, steps: [{ text: "a", status: "pending", owner: "x" }] },
    { ...plan, completed: [""] },
    { ...plan, steps: Array.from({ length: 31 }, (_, index) => ({ text: `s${index}`, status: "pending" })) },
    { ...plan, completed: Array.from({ length: 11 }, (_, index) => `s${index}`) },
    { kind: "pull_request", url: "https://gitlab.com/a/b/pull/1" },
    { kind: "pull_request", url: "https://github.com/a/b/pull/0" },
    { kind: "pull_request", url: "https://github.com/a/b/pull/1?x=1" },
    { kind: "pull_request", url: "https://github.com/a/b/pull/1", number: 2 },
    { kind: "pull_request", url: "https://github.com/a/b/pull/1", repository: "a/c" },
  ];
  for (const value of refused) {
    assert.throws(() => normalizeChannelActivity(value), ChannelActivityInvalid, JSON.stringify(value));
  }
});

test("a pull request report derives its coordinates from the URL", () => {
  const report = normalizeChannelActivity({
    kind: "pull_request", url: "https://github.com/LambdaLabsHQ/xmatrix/pull/3043",
  });
  assert.deepEqual(report, {
    kind: "pull_request", repository: "LambdaLabsHQ/xmatrix", number: 3043,
    url: "https://github.com/LambdaLabsHQ/xmatrix/pull/3043",
  });
  assert.equal(channelActivityLine(report), "↗ Opened pull request LambdaLabsHQ/xmatrix#3043");
});

test("only an activity entry's own metadata yields an activity", () => {
  assert.deepEqual(channelActivityOf({ xmatrixProvenance: "activity", xmatrixActivity: plan }), plan);
  assert.equal(channelActivityOf({ xmatrixProvenance: "system_fact", xmatrixActivity: plan }), undefined);
  assert.equal(channelActivityOf({ xmatrixProvenance: "activity", xmatrixActivity: { kind: "x" } }), undefined);
  assert.equal(channelActivityOf(undefined), undefined);
});

test("supersession is read only from the Hub's own annotation", () => {
  const judged = { namespace: "xmatrix.superseded", authorUserId: "system:xmatrix", payload: { supersededBy: "m-2" } };
  assert.equal(supersededByOf([judged]), "m-2");
  assert.equal(supersededByOf([{ ...judged, authorUserId: "user-1" }]), undefined);
  assert.equal(supersededByOf([{ ...judged, namespace: "memory" }]), undefined);
  assert.equal(supersededByOf([{ ...judged, payload: {} }]), undefined);
  assert.equal(supersededByOf(undefined), undefined);
});

test("caller metadata never carries a key only the Hub writes", () => {
  assert.deepEqual(callerMessageMetadata({
    kind: "xmatrix.questionnaire.v1",
    xmatrixProvenance: "system_fact",
    XmatrixSystemNotice: true,
    xmatrixActivity: plan,
    crossChannelReply: { sourceChannelId: "c" },
    appMentions: [{ app: "github" }],
    questions: [],
  }), { kind: "xmatrix.questionnaire.v1", questions: [] });
  assert.deepEqual(callerMessageMetadata(undefined), {});
  assert.deepEqual(callerMessageMetadata(["x"]), {});
});
