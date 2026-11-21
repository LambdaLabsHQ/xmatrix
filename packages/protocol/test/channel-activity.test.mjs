import assert from "node:assert/strict";
import test from "node:test";
import {
  callerMessageMetadata,
  ChannelActivityInvalid,
  channelActivityLine,
  channelActivityOf,
  normalizeChannelActivity,
} from "../dist/channel-activity.js";

const plan = {
  kind: "plan",
  completed: ["Run e2e regression"],
  inProgress: "Open PR 2",
  steps: [{ text: "Open PR 2", status: "in_progress" }],
};

test("a runtime plan is retired: a report of one is refused", () => {
  assert.throws(() => normalizeChannelActivity(plan),
    (error) => error instanceof ChannelActivityInvalid && error.reason === "plan_retired");
});

test("an activity line never carries an address", () => {
  const line = channelActivityLine({ kind: "pull_request", repository: "a@b/c", number: 1, url: "https://github.com/a/c/pull/1" });
  assert.doesNotMatch(line, /[@＠]/u);
});

test("malformed reports are refused rather than trimmed into something else", () => {
  const refused = [
    null, [], "plan", { kind: "note" },
    { kind: "pull_request", url: "https://github.com/a/b/pull/1", extra: true },
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
  const pull = { kind: "pull_request", repository: "a/b", number: 1, url: "https://github.com/a/b/pull/1" };
  assert.deepEqual(channelActivityOf({ xmatrixProvenance: "activity", xmatrixActivity: pull }), pull);
  assert.equal(channelActivityOf({ xmatrixProvenance: "system_fact", xmatrixActivity: pull }), undefined);
  // A stored entry of the retired plan is still activity, but carries none.
  assert.equal(channelActivityOf({ xmatrixProvenance: "activity", xmatrixActivity: plan }), undefined);
  assert.equal(channelActivityOf({ xmatrixProvenance: "activity", xmatrixActivity: { kind: "x" } }), undefined);
  assert.equal(channelActivityOf(undefined), undefined);
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
