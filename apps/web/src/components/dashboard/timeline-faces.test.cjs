const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { appendOutgoingTimelineItems, buildAgentWorkItems, buildTimeline, threadReplyParticipantsFromSummary } =
  require("./workspace-shell-recovered.tsx");

const reader = { id: "reader-1", email: "ada@example.com", name: "Ada" };
let sequence = 0;
function message(from, overrides = {}) {
  sequence += 1;
  return { messageId: `m-${sequence}`, channelId: "c1", sequence, body: "hello",
    sentAt: `2026-10-21T10:00:${String(sequence).padStart(2, "0")}Z`, from: { email: "", ...from }, ...overrides };
}
const faces = (history) => buildTimeline(history, null, [], [], reader).map((item) => item.face);

test("a person's message is drawn with their face, by their account, whatever picture the message carried", () => {
  assert.deepEqual(faces([message({ kind: "user", label: "Grace", userId: "grace-1",
    avatarUrl: "https://old.example.com/grace.png" })]), [{ kind: "user", id: "grace-1", name: "Grace" }]);
  assert.deepEqual(faces([message({ kind: "user", label: "Ada", userId: "reader-1", email: "ada@example.com" })]),
    [{ kind: "user", id: "reader-1", name: "Ada" }], "the reader's own message is theirs");
});

test("xMatrix's notices, written under their owner, are drawn as xMatrix", () => {
  assert.deepEqual(faces([message({ kind: "user", label: "xMatrix", userId: "owner-1",
    avatarUrl: "/brand/xmatrix-management-icon.png" }, { metadata: { xmatrixSystemNotice: true } })]),
  [{ kind: "system", name: "xMatrix" }]);
});

test("an Agent's message is drawn with its harness's face; an older one without a registration by its Instance", () => {
  const registration = { ownerUserId: "owner-1", machineId: "machine-1", harness: "codex" };
  assert.deepEqual(faces([
    message({ kind: "agent", label: "codex", instanceLabel: "codex:1", userId: "owner-1", instanceId: "c1:1", registration }),
    message({ kind: "agent", label: "claude", instanceLabel: "claude:2", userId: "owner-1", instanceId: "c1:2" }),
  ]), [
    { kind: "agent", name: "codex:1", harness: "codex", id: "c1:1" },
    { kind: "agent", name: "claude:2", harness: null, id: "c1:2" },
  ]);
});

test("an author imported from Slack is drawn with the picture Slack gave", () => {
  assert.deepEqual(faces([message({ kind: "user", label: "Lin", userId: "slack:U123",
    avatarUrl: "https://avatars.slack-edge.com/lin.png" })]),
  [{ kind: "external", name: "Lin", imageUrl: "https://avatars.slack-edge.com/lin.png" }]);
});

test("a relayed reply is drawn as who answered elsewhere, not as the link's owner", () => {
  const relay = (crossChannelReply) => ({ metadata: { xmatrixProvenance: "cross_channel_reply",
    crossChannelReply: { sourceChannelId: "elsewhere", ...crossChannelReply } } });
  const owner = { kind: "user", userId: "owner-1", identityId: "user:owner-1" };
  assert.deepEqual(faces([
    message({ ...owner, label: "gemini" }, relay({ replierKind: "agent", replierAgentId: "agent-9",
      replierInstanceId: "elsewhere:3", replierRegistration: { ownerUserId: "owner-1", machineId: "m", harness: "gemini" } })),
    message({ ...owner, label: "Grace", avatarUrl: "https://example.com/grace.png" }, relay({ replierKind: "user" })),
  ]), [
    { kind: "agent", name: "gemini", harness: "gemini", id: "elsewhere:3" },
    { kind: "external", name: "Grace", imageUrl: "https://example.com/grace.png" },
  ]);
});

test("the reader's message on its way is drawn with their face", () => {
  const pending = appendOutgoingTimelineItems([], [{ clientMessageId: "x", channelId: "c1", body: "hi", attachments: [],
    appMentions: [], sentAt: "2026-10-21T10:01:00Z", status: "pending" }], "c1", reader);
  assert.deepEqual(pending.map((item) => item.face), [{ kind: "user", id: "reader-1", name: "Ada" }]);
});

test("a thread's participants are drawn as who they are", () => {
  const root = message({ kind: "user", label: "Ada", userId: "reader-1" }, { thread: { channelId: "t1", replyCount: 2,
    replies: [message({ kind: "agent", label: "codex", userId: "owner-1", instanceId: "t1:1",
      registration: { ownerUserId: "owner-1", machineId: "m", harness: "codex" } }, { channelId: "t1" }),
    message({ kind: "user", label: "Grace", userId: "grace-1" }, { channelId: "t1" })] } });
  assert.deepEqual(threadReplyParticipantsFromSummary(root).map((participant) => participant.face), [
    { kind: "agent", name: "codex", harness: "codex", id: "t1:1" },
    { kind: "user", id: "grace-1", name: "Grace" },
  ]);
});

test("the dock draws a live Instance by its harness, and a launch by the Instance it records", () => {
  const channel = { id: "c1", spaceId: "s1", name: "c", mode: "open",
    presence: { channelId: "c1", humans: new Map(), instances: new Map([["c1:1", { id: "c1:1", channelId: "c1",
      agentName: "codex", label: "codex:1", status: "online", connectedAt: "2026-10-21T10:00:00Z",
      registration: { ownerUserId: "owner-1", machineId: "m", harness: "codex" } }]]) } };
  const items = buildAgentWorkItems(channel, [], [{ launchId: "l1", channelId: "c1", sourceMessageId: "m", targetName: "claude",
    launchKind: "summon", runId: "run-1", instanceId: "c1:2", state: "queued", attempt: 1, retryable: false,
    createdAt: "2026-10-21T10:00:01Z", updatedAt: "2026-10-21T10:00:01Z" }]);
  assert.deepEqual(items.map((item) => item.face), [
    { kind: "agent", name: "codex", harness: "codex", id: "c1:1" },
    { kind: "agent", name: "claude", id: "c1:2" },
  ]);
  assert.deepEqual(items.map((item) => item.target.face), items.map((item) => item.face), "its trace opens with the same face");
});
