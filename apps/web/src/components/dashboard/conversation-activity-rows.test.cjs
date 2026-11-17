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
  assert.equal(rows.length, 4);
  const [, fold, pull, finding] = rows;
  assert.equal(fold.folded.length, 2);
  assert.equal(fold.id, "fold:message:m-2", "keyed by the run's first entry");
  assert.equal(fold.sequence, 3, "exposes the run's newest entry as read");
  assert.equal(fold.messageId, undefined);
  assert.deepEqual(foldSummary(fold.folded).segments, ["✓ lint", "✓ tsc", "✓ e2e 191/191"]);
  assert.deepEqual(pull.pullRequests.map((line) => line.ref),
    [{ repository: "a/b", number: 3043, url: "https://github.com/a/b/pull/3043" }], "a pull request is its own slip");
  assert.equal(finding.folded, undefined, "a finding is talk and stays whole");
  assert.equal(finding.continuation, true, "a pull request is its opener's message when GitHub said nothing of it");
});

const github = { author: "GitHub", kind: "app", id: "app:github" };
function githubFact(number, minute, fact) {
  return said(github, fact.event, minute, { metadata: { xmatrixGitHubPullRequest: {
    repository: "a/b", number, url: `https://github.com/a/b/pull/${number}`, ...fact } } });
}

test("a stretch of pull request facts is one slip, one entry per pull request; people's words stay whole", () => {
  sequence = 0;
  const rows = buildConversationRows([
    said(claude1, "Cause: no retry after the network drops.", 10),
    pullRequest(claude1, 121, 18),
    githubFact(121, 19, { event: "ci_passed", sha: "3ffa10b" }),
    pullRequest(claude1, 122, 24),
    githubFact(121, 25, { event: "reviewed", actor: "yiming", verdict: "changes requested", words: "Back off." }),
    githubFact(122, 27, { event: "ci_failed", sha: "9c41d2e", failed: [{ name: "web" }], more: 0 }),
    githubFact(121, 29, { event: "merged", title: "Reload on reconnect" }),
  ]);
  assert.deepEqual(rows.map((row) => row.pullRequests
    ? row.pullRequests.map((line) => `#${line.ref.number}:${line.items.length}`).join(" ")
    : row.body), ["Cause: no retry after the network drops.", "#121:2 #122:1", "reviewed", "#122:1 #121:1"]);
  assert.equal(rows[1].id, "pull:message:m-2");
  assert.equal(rows[1].folded.length, 3, "every entry of the stretch is read with it");
  assert.equal(rows[1].author, "GitHub", "a stretch GitHub spoke in is GitHub's message");
  assert.equal(rows[2].continuation, true, "GitHub's messages moments apart read as one turn, like any sender's");
});

test("a pull request is named by the latest title GitHub said, in later stretches too", () => {
  sequence = 0;
  const rows = buildConversationRows([
    pullRequest(claude1, 121, 18),
    githubFact(121, 18, { event: "subscribed", title: "Reload when the network returns" }),
    said(yiming, "Looks right.", 20),
    githubFact(121, 21, { event: "ci_failed", sha: "9c41d2e", failed: [{ name: "web" }], more: 0 }),
    said(yiming, "Rename it?", 22),
    githubFact(121, 23, { event: "closed", title: "Reload on reconnect" }),
  ]);
  const titles = rows.filter((row) => row.pullRequests).map((row) => row.pullRequests[0].title);
  assert.deepEqual(titles, ["Reload when the network returns", "Reload when the network returns", "Reload on reconnect"]);
  sequence = 0;
  const untitled = buildConversationRows([pullRequest(claude1, 7, 18)]);
  assert.equal("title" in untitled[0].pullRequests[0], false, "a pull request GitHub has not named is its number");
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

test("a message on its way is grouped the way it will be once the server confirms it", () => {
  const first = said(yiming, "first", 0);
  // What the composer adds the moment the reader sends: no id from the server yet.
  const onItsWay = { id: "client:c-1", clientMessageId: "c-1", body: "second", sentAt: at(1),
    author: "Yiming Hu", own: true, senderKind: "user", senderId: "user:yiming", sendStatus: "pending" };
  const [, pending] = buildConversationRows([first, onItsWay]);
  assert.equal(pending.continuation, true, "under the sender's own message, without a second header");
  const [, confirmed] = buildConversationRows([first, { ...onItsWay, messageId: "m-confirmed", sendStatus: undefined }]);
  assert.equal(confirmed.continuation, true, "and the same once confirmed, so the row does not change shape");
  for (const sendStatus of ["unconfirmed", "failed"]) {
    const [, stalled] = buildConversationRows([first, { ...onItsWay, sendStatus }]);
    assert.equal(stalled.continuation, undefined, `${sendStatus}: the header is where the row says so`);
  }
});


test("an outside app source stays visible when the same person switches apps", () => {
  const app = (clientId, name) => ({ metadata: { xmatrixMcpApplication: { clientId, name } } });
  const rows = buildConversationRows([
    said(yiming, "Typed in xMatrix", 0),
    said(yiming, "Sent in Chat", 1, app("chat-client", "Chat")),
    said(yiming, "More in Chat", 2, app("chat-client", "Chat")),
    said(yiming, "Sent in Cursor", 3, app("cursor-client", "Cursor")),
    said(yiming, "Back in xMatrix", 4),
  ]);
  assert.deepEqual(rows.map((row) => Boolean(row.continuation)), [false, false, true, false, false]);
  assert.ok(rows.every((row) => row.senderId === yiming.id), "the application is not another actor");
});
