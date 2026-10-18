const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { queuedBehindTurns } = require("./queued-behind-turn.ts");

const at = (iso) => Date.parse(iso);
const grok = (execution, status = "busy") => ({ id: "channel:1", channelId: "channel", agentName: "grok", channelInstanceId: "1",
  status, registration: {}, runtimeState: execution ? { status: "running", execution } : { status: "idle" } });
const working = { executionId: "e1", revision: 1, sourceCount: 1, sources: [{ messageId: "m1" }], state: "accepted",
  startedAtMillis: at("2026-10-18T05:19:38Z"), updatedAtMillis: at("2026-10-18T05:19:38Z") };
const sent = (messageId, body, sentAt, extra = {}) => ({ id: messageId, messageId, body, sentAt, own: true, senderKind: "user", ...extra });

test("a message to an Instance still on an earlier turn says whom it waits on and since when", () => {
  const timeline = [sent("m1", "@grok:1 write the page", "2026-10-18T05:19:30Z"),
    sent("m2", "@grok:1 are you there?", "2026-10-18T05:23:00Z")];
  const queued = queuedBehindTurns(timeline, [grok(working)]);
  assert.deepEqual([...queued.keys()], ["m2"], "the message its turn already took does not wait");
  assert.deepEqual(queued.get("m2"), [{ address: "@grok:1", since: "2026-10-18T05:19:38.000Z" }]);
});

test("a reply to the Instance waits the same way; a message to another, or an idle one, does not", () => {
  const agentMessage = { id: "a1", messageId: "a1", body: "draft is up", sentAt: "2026-10-18T05:10:00Z",
    senderKind: "agent", senderId: "channel:1" };
  const reply = sent("m3", "make it shorter", "2026-10-18T05:24:00Z", { replyToMessageId: "a1" });
  assert.deepEqual([...queuedBehindTurns([agentMessage, reply], [grok(working)]).keys()], ["m3"]);
  assert.equal(queuedBehindTurns([sent("m4", "@codex:1 hi", "2026-10-18T05:24:00Z")], [grok(working)]).size, 0);
  assert.equal(queuedBehindTurns([sent("m2", "@grok:1 hi", "2026-10-18T05:24:00Z")], [grok(undefined)]).size, 0);
  // A turn that began after the message is the one taking it.
  assert.equal(queuedBehindTurns([sent("m5", "@grok:1 hi", "2026-10-18T05:18:00Z")], [grok(working)]).size, 0);
  // Someone else's message is theirs to see.
  assert.equal(queuedBehindTurns([sent("m6", "@grok:1 hi", "2026-10-18T05:24:00Z", { own: false })], [grok(working)]).size, 0);
});
