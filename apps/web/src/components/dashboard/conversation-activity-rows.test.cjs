const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { buildConversationRows, foldSummary, sinceDigest, sinceDigestLine } = require("./conversation-activity-rows.ts");

/**
 * A conversation keeps talk whole and folds progress, without losing who did
 * what in which order (docs/design/conversation-activity.md §4.1).
 */

let sequence = 0;
function at(minute) {
  return new Date(Date.UTC(2026, 8, 27, 18, minute)).toISOString();
}
function said(sender, body, minute, extra = {}) {
  sequence += 1;
  return { id: `message:m-${sequence}`, messageId: `m-${sequence}`, sequence, body, sentAt: at(minute),
    author: sender.author, senderKind: sender.kind, senderId: sender.id, senderInstanceId: sender.instance,
    ...extra };
}
function step(sender, completed, minute, inProgress) {
  return said(sender, completed.map((text) => `✓ ${text}`).join(" · "), minute, {
    metadata: { xmatrixProvenance: "activity", xmatrixActivity: {
      kind: "plan", completed, ...(inProgress ? { inProgress } : {}),
      steps: completed.map((text) => ({ text, status: "completed" })) } },
  });
}
function pullRequest(sender, number, minute) {
  return said(sender, `↗ Opened pull request a/b#${number}`, minute, {
    metadata: { xmatrixProvenance: "activity", xmatrixActivity: {
      kind: "pull_request", repository: "a/b", number, url: `https://github.com/a/b/pull/${number}` } },
  });
}

const claude1 = { author: "claude:1", kind: "agent", id: "agent-claude", instance: "i-1" };
const claude2 = { author: "claude:2", kind: "agent", id: "agent-claude", instance: "i-2" };
const codex = { author: "codex:2", kind: "agent", id: "agent-codex", instance: "i-9" };
const yiming = { author: "Yiming Hu", kind: "user", id: "user:yiming" };

test("one Instance's run of activity folds into one row that keeps its place", () => {
  const rows = buildConversationRows([
    said(yiming, "Please build PR 2", 0),
    step(claude1, ["lint", "tsc"], 27),
    step(claude1, ["e2e 191/191"], 28),
    pullRequest(claude1, 3043, 29),
    said(claude1, "The two db failures also fail on main: known baseline.", 29),
  ]);
  assert.equal(rows.length, 3);
  const [, fold, finding] = rows;
  assert.equal(fold.folded.length, 3);
  assert.equal(fold.id, "fold:message:m-2", "keyed by the run's first entry");
  assert.equal(fold.sequence, 4, "exposes the run's newest entry as read");
  assert.equal(fold.messageId, undefined);
  assert.deepEqual(foldSummary(fold.folded).segments, ["✓ lint", "✓ tsc", "✓ e2e 191/191", "↗ a/b#3043"]);
  assert.equal(finding.folded, undefined, "a finding is talk and stays whole");
  assert.equal(finding.continuation, undefined, "a fold above breaks continuation");
});

test("anyone else's entry ends a run, so interleaving stays visible", () => {
  const rows = buildConversationRows([
    step(claude1, ["a"], 27),
    step(codex, ["merged #3041"], 33),
    step(claude1, ["b"], 34),
    step(claude2, ["c"], 35),
  ]);
  assert.deepEqual(rows.map((row) => row.folded.map((item) => item.author)),
    [["claude:1"], ["codex:2"], ["claude:1"], ["claude:2"]]);
});

test("a superseded report folds; the newest and any engaged message stay whole", () => {
  const rows = buildConversationRows([
    said(claude1, "Progress: running e2e", 27, { supersededBy: "m-2" }),
    said(claude1, "Progress: e2e passed", 29),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].folded.length, 1);
  assert.equal(rows[1].folded, undefined);
  const recalled = buildConversationRows([
    said(claude1, "", 27, { supersededBy: "m-9", recalledAt: at(28) }),
  ]);
  assert.equal(recalled[0].folded, undefined);
});

test("a judgment that arrived later folds a message already on screen", () => {
  const earlier = said(claude1, "Progress: writing the CLI", 30);
  const later = said(claude1, "CLI merged into PR 2", 36);
  const rows = buildConversationRows([earlier, later], new Map([[earlier.messageId, later.messageId]]));
  assert.equal(rows[0].folded[0].supersededBy, later.messageId);
});

test("a message right after its sender's own drops the header, until tags or time change", () => {
  const first = said(yiming, "one", 0);
  const second = said(yiming, "two", 5);
  const late = said(yiming, "three", 20);
  const [a, b, c] = buildConversationRows([first, second, late]);
  assert.equal(a.continuation, undefined);
  assert.equal(b.continuation, true);
  assert.equal(c.continuation, undefined, "more than ten minutes later");
  const branch = (branchName, minute) => said(claude1, "x", minute, { senderGitBranch: branchName });
  const [, changed] = buildConversationRows([branch("main", 0), branch("feat/x", 1)]);
  assert.equal(changed.continuation, undefined, "changed tags reappear");
  assert.deepEqual(changed.retagged.keys, ["branch"], "the header names the tag that changed");
  const [, other] = buildConversationRows([said(claude1, "x", 0), said(claude2, "y", 1)]);
  assert.equal(other.continuation, undefined, "another Instance of the same Agent");
  const beforeMidnight = { ...said(yiming, "late", 0), sentAt: new Date(2026, 8, 27, 23, 59).toISOString() };
  const afterMidnight = { ...said(yiming, "early", 0), sentAt: new Date(2026, 8, 28, 0, 1).toISOString() };
  const [, nextDay] = buildConversationRows([beforeMidnight, afterMidnight]);
  assert.equal(nextDay.continuation, undefined, "a new local day shows its dated header; there is no day divider");
});

test("the since digest counts what happened after the reader's position", () => {
  sequence = 0;
  const rows = buildConversationRows([
    said(yiming, "go", 0),
    step(claude1, ["a", "b"], 27),
    pullRequest(claude1, 3043, 28),
    said(claude1, "Should I merge?", 29, {
      mentionReadStatuses: [{ targetId: "user:yiming", targetKind: "user", label: "Yiming", status: "unread" }],
    }),
  ]);
  const digest = sinceDigest(rows, 1, "user:yiming");
  assert.equal(digest.index, 1);
  assert.equal(digest.messages, 1);
  assert.equal(digest.mentions, 1);
  assert.equal(digest.folded, 2);
  assert.deepEqual(digest.pullRequests, ["a/b#3043"]);
  assert.equal(sinceDigestLine(digest),
    "Since you last read · 1 mention of you · 1 message · ↗ a/b#3043 · 2 updates folded · from claude:1");
  assert.equal(sinceDigest(rows, 99, "user:yiming"), undefined, "nothing unread");
  assert.equal(sinceDigest(rows, undefined, "user:yiming"), undefined, "position unknown");
});

test("a header back within a turn names the changed tags, across the sender's own fold", () => {
  const chips = (effort) => [{ id: "Model", value: "opus" }, { id: "effort", value: effort }];
  const rows = buildConversationRows([
    said(claude1, "merging was my call", 30, { senderGitBranch: "paper-label-tags", senderStatusChips: chips("med") }),
    pullRequest(claude1, 245, 30),
    said(claude1, "effort is its own tag again", 31, { senderGitBranch: "split-effort-tag", senderStatusChips: chips("high") }),
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].continuation, undefined);
  assert.equal(rows[2].retagged.previous, rows[0], "compared with the message above the fold");
  assert.deepEqual(rows[2].retagged.keys, ["branch", "effort"]);
  const [, sameTags] = buildConversationRows([said(claude1, "a", 0), pullRequest(claude1, 1, 1), said(claude1, "b", 2)]);
  assert.equal(sameTags.retagged, undefined);
  const [, , afterOther] = buildConversationRows([
    said(claude1, "a", 0, { senderGitBranch: "x" }), said(yiming, "ok", 1), said(claude1, "b", 2, { senderGitBranch: "y" }),
  ]);
  assert.equal(afterOther.retagged, undefined, "someone else in between starts a fresh header");
});
