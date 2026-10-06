const assert = require("node:assert/strict");

const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  applyMemberReadEvent,
  buildMentionReadIndex,
  composerMentionSpans,
  machineOfflineMentionSubjects,
  mentionChipLabel,
  mentionReadResolution,
  splitMentionSegments,
  withMemberReadSequence,
  withInvocationMentionTargets,
  withWrittenInvocationTargets,
} = require("./mention-read-state.ts");

const CANDIDATES = [
  { id: "user:u-yiming", name: "Yiming Hu", handle: "yiming-hu", kind: "user", status: "online", avatarUrl: "/a.png" },
  // Same display-name token as the member above, different person. Indexing
  // display names made `@Yiming` a coin flip between the two.
  { id: "user:u-legend", name: "Yiming", handle: "legend", kind: "user", status: "online" },
  { id: "profile-codex", name: "codex", kind: "agent", status: "offline", mention: "codex" },
  { id: "profile-codex-mba", name: "codex-mba", kind: "agent", status: "offline", mention: "codex-mba" },
  { id: "app:slack", name: "Slack", kind: "app", status: "online", appId: "slack" },
];

const INDEX = buildMentionReadIndex(CANDIDATES);

function mentions(text) {
  return splitMentionSegments(text, INDEX)
    .filter((segment) => segment.kind === "mention")
    .map((segment) => ({ text: segment.text, subjectId: segment.target.subjectId }));
}

test("a mention of an Agent whose machine is unreachable is marked as such", () => {
  const instance = (id, status, extra = {}) => ({
    id, status, label: id, connectedAt: "2026-10-01T02:00:00Z", lastSeenAt: "2026-10-01T02:30:00Z", ...extra,
  });
  const subjects = machineOfflineMentionSubjects({
    memberPresence: {
      "agent:claude": { kind: "agent", instances: [
        instance("i-1", "offline", { offlineReason: "machine_offline" }),
      ] },
      // Another Instance still reads, so the Agent itself is reachable.
      "agent:codex": { kind: "agent", instances: [
        instance("i-2", "offline", { offlineReason: "machine_offline" }),
        instance("i-3", "idle"),
      ] },
      "agent:grok": { kind: "agent", instances: [instance("i-4", "idle")] },
      "user:u-1": { kind: "user", status: "offline" },
    },
  });
  assert.deepEqual([...subjects].sort(), ["agent:claude", "agent:claude:i-1", "agent:codex:i-2"]);
  assert.equal(machineOfflineMentionSubjects(undefined).size, 0);
});

test("a human is addressed by handle", () => {
  assert.deepEqual(mentions("@yiming-hu please look"), [
    { text: "@yiming-hu", subjectId: "user:u-yiming" },
  ]);
});

test("display names resolve longest first, including spaces and CJK", () => {
  assert.deepEqual(mentions("@Yiming Hu please look"), [
    { text: "@Yiming Hu", subjectId: "user:u-yiming" },
  ]);
  assert.deepEqual(mentions("@Yiming please look"), [
    { text: "@Yiming", subjectId: "user:u-legend" },
  ]);
  const index = buildMentionReadIndex([
    { id: "user:cn", name: "王力", kind: "user" },
  ]);
  assert.equal(splitMentionSegments("＠王力 请看", index)[0].target.subjectId, "user:cn");
});

test("ambiguous names stay plain text without falling back to a shorter name", () => {
  const candidates = [
    { id: "user:1", name: "Yiming Hu", handle: "one", kind: "user" },
    { id: "user:2", name: "Yiming Hu", handle: "two", kind: "user" },
    { id: "user:3", name: "Yiming", kind: "user" },
  ];
  for (const entries of [candidates, [...candidates].reverse()]) {
    const index = buildMentionReadIndex(entries);
    assert.deepEqual(splitMentionSegments("@Yiming Hu hello", index), [
      { kind: "text", text: "@Yiming Hu hello" },
    ]);
    assert.equal(splitMentionSegments("@one hello", index)[0].target.subjectId, "user:1");
  }
  const collision = buildMentionReadIndex([
    { id: "user:1", name: "codex", kind: "user" },
    { id: "agent:1", name: "codex", kind: "agent" },
  ]);
  assert.equal(collision.byToken.has("codex"), false);
});

test("a mention reads as a name and is addressed by a handle", () => {
  // The point of carrying both fields: `@eevee` is unique, "Legend Wang" is
  // recognisable. Rendering the raw token made every mention unreadable.
  const [segment] = splitMentionSegments("@yiming-hu please look", INDEX)
    .filter((s) => s.kind === "mention");
  assert.equal(mentionChipLabel(segment.text, segment.target.label, segment.token), "Yiming Hu");
});

test("a control tail survives the name swap", () => {
  // The tail is syntax, not identity, so it stays exactly as written.
  assert.equal(mentionChipLabel("@codex:3:reborn", "codex", "codex"), "codex:3:reborn");
  assert.equal(
    mentionChipLabel("@yiming-hu:new:LambdaLabsHQ/xmatrix", "Yiming Hu", "yiming-hu"),
    "Yiming Hu:new:LambdaLabsHQ/xmatrix",
  );
});

test("without a resolving token the written text is left alone", () => {
  // Never rewrite a prefix that did not resolve the mention.
  assert.equal(mentionChipLabel("@someone-else", "Yiming Hu"), "someone-else");
  assert.equal(mentionChipLabel("@someone-else", "Yiming Hu", "yiming-hu"), "someone-else");
});

test("a mention followed by CJK text still renders a chip", () => {
  // The Hub recorded attention for this and the client rendered nothing, so a
  // reader was notified about a mention they could not see in the message.
  assert.deepEqual(mentions("@codex的输出有问题"), [
    { text: "@codex", subjectId: "agent:profile-codex" },
  ]);
});

test("the longest known member wins over a shorter prefix", () => {
  assert.deepEqual(mentions("ping @codex-mba now"), [
    { text: "@codex-mba", subjectId: "agent:profile-codex-mba" },
  ]);
});

test("an agent mention carries its instance and summon tail", () => {
  assert.deepEqual(mentions("@codex:new:LambdaLabsHQ/xmatrix go"), [
    { text: "@codex:new:LambdaLabsHQ/xmatrix", subjectId: "agent:profile-codex" },
  ]);
});

test("mention chips retain complete summon and reborn commands", () => {
  assert.equal(
    mentionChipLabel("@codex:new:LambdaLabsHQ/xmatrix", "codex"),
    "codex:new:LambdaLabsHQ/xmatrix"
  );
  assert.equal(mentionChipLabel("@codex:3:reborn", "codex"), "codex:3:reborn");
  assert.equal(
    mentionChipLabel("@codex:3:handoff:@grok-windows", "codex"),
    "codex:3:handoff:@grok-windows",
  );
});

test("only channel members become mentions", () => {
  assert.deepEqual(mentions("mail someone@example.com and @nobody"), []);
});

test("app mentions stay plain text", () => {
  assert.deepEqual(mentions("@Slack:send hello"), []);
});

test("a mention opens after CJK punctuation and at a bracket", () => {
  assert.deepEqual(mentions("（@codex 看下）"), [
    { text: "@codex", subjectId: "agent:profile-codex" },
  ]);
});

test("text with no mention stays one plain segment", () => {
  assert.deepEqual(splitMentionSegments("nothing here", INDEX), [
    { kind: "text", text: "nothing here" },
  ]);
});

const TARGET = { subjectId: "user:u-yiming", kind: "user", label: "Yiming Hu" };

test("a cursor at or past the message sequence reads as read", () => {
  assert.equal(
    mentionReadResolution({
      target: TARGET,
      messageSequence: 12,
      memberReadSequences: { "user:u-yiming": 12 },
    }).state,
    "read"
  );
  assert.equal(
    mentionReadResolution({
      target: TARGET,
      messageSequence: 12,
      memberReadSequences: { "user:u-yiming": 11 },
    }).state,
    "unread"
  );
});

test("a member with no cursor in a projected channel has read nothing", () => {
  assert.equal(
    mentionReadResolution({ target: TARGET, messageSequence: 3, memberReadSequences: {} }).state,
    "unread"
  );
});

test("a channel without a read projection stays unknown", () => {
  assert.equal(mentionReadResolution({ target: TARGET, messageSequence: 3 }).state, "unknown");
  assert.equal(
    mentionReadResolution({ target: TARGET, memberReadSequences: { "user:u-yiming": 9 } }).state,
    "unknown"
  );
});

test("a server-sent status outranks the derived cursor", () => {
  const resolution = mentionReadResolution({
    target: TARGET,
    messageSequence: 12,
    memberReadSequences: { "user:u-yiming": 1 },
    serverStatuses: [{
      targetId: "u-yiming",
      targetKind: "user",
      label: "Yiming Hu",
      status: "read",
      readAt: "2026-08-05T02:00:00.000Z",
    }],
  });
  assert.equal(resolution.state, "read");
  assert.equal(resolution.readAt, "2026-08-05T02:00:00.000Z");
});

test("an unknown server status falls back to the cursor", () => {
  assert.equal(
    mentionReadResolution({
      target: TARGET,
      messageSequence: 12,
      memberReadSequences: { "user:u-yiming": 20 },
      serverStatuses: [{
        targetId: "user:u-yiming",
        targetKind: "user",
        label: "Yiming Hu",
        status: "unknown",
      }],
    }).state,
    "read"
  );
});

test("a member cursor never moves backwards", () => {
  const channel = { id: "c-1", memberReadSequences: { "user:u-yiming": 20 } };
  assert.equal(withMemberReadSequence(channel, "user:u-yiming", 12), channel);
  assert.deepEqual(
    withMemberReadSequence(channel, "user:u-yiming", 21).memberReadSequences,
    { "user:u-yiming": 21 }
  );
});

test("a live read event only touches its own channel", () => {
  const channels = [
    { id: "c-1", memberReadSequences: {} },
    { id: "c-2", memberReadSequences: {} },
  ];
  const next = applyMemberReadEvent(channels, {
    channelId: "c-1",
    metadata: { subjectId: "user:u-yiming", readSequence: 7 },
  });
  assert.deepEqual(next[0].memberReadSequences, { "user:u-yiming": 7 });
  assert.equal(next[1], channels[1]);
});

test("a malformed live read event changes nothing", () => {
  const channels = [{ id: "c-1", memberReadSequences: {} }];
  assert.equal(applyMemberReadEvent(channels, { channelId: "c-1", metadata: {} })[0], channels[0]);
  assert.equal(applyMemberReadEvent(channels, { metadata: { subjectId: "user:u-yiming", readSequence: 4 } })[0], channels[0]);
});

test("pending launches resolve before an Agent joins, including opaque written addresses", () => {
  const index = withInvocationMentionTargets(buildMentionReadIndex([]), [{
    instanceId: "agent:pending", targetName: "Codex", sourceMention: "@profile-id:new:owner/repo",
  }]);
  const segments = splitMentionSegments("@profile-id:new:owner/repo", index);
  assert.equal(segments[0].target.subjectId, "agent:pending");
  assert.equal(segments[0].token, "profile-id");
});

test("exact Agent summons render only the display name and command tail", () => {
  const id = "agent:3633dad6-8f5a-4390-98c1-60a95f541f61:9ad8182b";
  const sourceMention = `@${id}:once:LambdaLabsHQ/xmatrix`;
  for (const index of [
    withInvocationMentionTargets(buildMentionReadIndex([]), [{
      instanceId: id, targetName: "codex", sourceMention,
    }]),
    buildMentionReadIndex([{ id, name: "codex", mention: "codex", kind: "agent" }]),
  ]) {
    const segment = splitMentionSegments(sourceMention, index)[0];
    assert.equal(segment.target.subjectId, id);
    assert.equal(segment.token, id);
    assert.equal(mentionChipLabel(segment.text, segment.target.label, segment.token),
      "codex:once:LambdaLabsHQ/xmatrix");
    assert.deepEqual(splitMentionSegments("@agent:another-owner:other:once:owner/repo", index),
      [{ kind: "text", text: "@agent:another-owner:other:once:owner/repo" }]);
  }
});

test("same-name pending summons retain distinct complete Agent addresses", () => {
  const launches = ["agent:owner:a", "agent:owner:b"].map(instanceId => ({
    instanceId, targetName: "codex", sourceMention: `@${instanceId}:once:owner/repo`,
  }));
  const index = withInvocationMentionTargets(buildMentionReadIndex([]), launches);
  for (const launch of launches) {
    const segment = splitMentionSegments(launch.sourceMention, index)[0];
    assert.equal(segment.target.subjectId, launch.instanceId);
    assert.equal(segment.token, launch.instanceId);
  }
  assert.equal(index.byToken.has("agent"), false);
  assert.deepEqual(splitMentionSegments("@codex:once:owner/repo", index),
    [{ kind: "text", text: "@codex:once:owner/repo" }]);
});

test("a unique harness launch names a shared Agent even when membership cannot", () => {
  const membership = buildMentionReadIndex([
    { id: "agent:owner:a", name: "codex", mention: "codex", kind: "agent" },
    { id: "agent:owner:b", name: "codex", mention: "codex", kind: "agent" },
  ]);
  assert.equal(membership.byToken.has("codex"), false);
  assert.deepEqual(splitMentionSegments("@codex:new:LambdaLabsHQ/xmatrix", membership), [
    { kind: "text", text: "@codex:new:LambdaLabsHQ/xmatrix" },
  ]);
  const index = withInvocationMentionTargets(membership, [{
    instanceId: "agent:owner:b",
    targetName: "codex",
    sourceMention: "@codex:new:LambdaLabsHQ/xmatrix",
  }]);
  const segment = splitMentionSegments("@codex:new:LambdaLabsHQ/xmatrix", index)[0];
  assert.equal(segment.kind, "mention");
  assert.equal(segment.target.subjectId, "agent:owner:b");
  assert.equal(segment.token, "codex");
});

test("two harness launches to different Agents leave the shared name unresolved", () => {
  const index = withInvocationMentionTargets(buildMentionReadIndex([]), [
    { instanceId: "agent:owner:a", targetName: "codex", sourceMention: "@codex:new:one/repo" },
    { instanceId: "agent:owner:b", targetName: "codex", sourceMention: "@codex:new:two/repo" },
  ]);
  assert.deepEqual(splitMentionSegments("@codex:new:one/repo", index), [
    { kind: "text", text: "@codex:new:one/repo" },
  ]);
});

test("a bare harness shout keeps its chip before launch evidence arrives", () => {
  // `@codex` is a harness capability shout, not a unique member, so membership
  // may leave it ambiguous and the routed launch query is asynchronous. The
  // written shout keeps the `@` highlight as an unresolved Agent target until
  // the launch can name it.
  const index = withWrittenInvocationTargets(buildMentionReadIndex([]), "@codex run the suite");
  const shout = splitMentionSegments("@codex run the suite", index)[0];
  assert.equal(shout.kind, "mention");
  assert.equal(shout.token, "codex");
  assert.equal(shout.target.unresolved, true);
});

test("a written fallback never covers a plain name or an instance address", () => {
  const resolve = (text) => splitMentionSegments(text,
    withWrittenInvocationTargets(buildMentionReadIndex([]), text));
  assert.deepEqual(resolve("@alice hello"), [{ kind: "text", text: "@alice hello" }]);
  assert.equal(resolve("@codex:1 status")[0].kind, "text");
  assert.equal(resolve("@codex:1:reborn now")[0].kind, "text");
});

test("a resolved member is never replaced by the written fallback", () => {
  const membership = buildMentionReadIndex([{ id: "profile-codex", name: "codex", kind: "agent", mention: "codex" }]);
  const index = withWrittenInvocationTargets(membership, "@codex do it");
  const segment = splitMentionSegments("@codex do it", index)[0];
  assert.equal(segment.target.subjectId, "agent:profile-codex");
  assert.equal(segment.target.unresolved, undefined);
});

test("an unresolved written shout never borrows a member's read cursor", () => {
  const index = withWrittenInvocationTargets(buildMentionReadIndex([]), "@codex do it");
  const target = splitMentionSegments("@codex do it", index)[0].target;
  assert.equal(mentionReadResolution({
    target,
    messageSequence: 5,
    memberReadSequences: { "written:codex": 99 },
  }).state, "unknown");
  assert.equal(mentionReadResolution({ target, messageSequence: 5, memberReadSequences: {} }).state, "unknown");
});

test("the draft paints exactly the mentions the sent message will chip", () => {
  const spans = (text) => composerMentionSpans(text, INDEX, "user:u-yiming")
    .map(({ start, end, kind, self }) => ({ text: text.slice(start, end), kind, ...(self ? { self } : {}) }));
  // A member name ends where the name ends: CJK text, full-width punctuation
  // and the CJK brackets around it are not part of the mention.
  assert.deepEqual(spans("请 @legend，看（@codex-mba）和 @codex的输出。"), [
    { text: "@legend", kind: "user" },
    { text: "@codex-mba", kind: "agent" },
    { text: "@codex", kind: "agent" },
  ]);
  // Full-width ＠ addresses the same member; the viewer's own mention is marked.
  assert.deepEqual(spans("＠yiming-hu 看"), [{ text: "＠yiming-hu", kind: "user", self: true }]);
  // Unknown names, e-mail addresses, code spans and quotes never become chips.
  assert.deepEqual(spans("@nobody a@legend.com `@legend`\n> @legend"), []);
});

test("a summon paints its whole written expression, flagging force and malformed conditions", () => {
  const text = "@codex repo:owner/xmatrix launch:force 修一下 @auto repo:owner/xmatrix pwd:/tmp";
  const spans = composerMentionSpans(text, INDEX);
  assert.deepEqual(spans.map(({ start, end, kind, forced }) => ({ text: text.slice(start, end), kind, ...(forced ? { forced } : {}) })), [
    { text: "@codex repo:owner/xmatrix launch:force", kind: "summon", forced: true },
    { text: "@auto repo:owner/xmatrix pwd:/tmp", kind: "summon" },
  ]);
  assert.equal(spans[0].invalid, undefined);
  assert.equal(spans[1].invalid, true);
});
