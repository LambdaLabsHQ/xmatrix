const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { loadInvocationPages, invocationSourceMessages } = require("./mention-invocation-query.ts");

test("visible continuation messages use shared grammar including full-width and mixed case mentions", () => {
  const messages = ["＠Alpha:1:ReBoRn go", "@Alpha:1:handoff:@Beta go", "@Alpha:1 ordinary task"]
    .map((body, index) => ({ id: `m${index}`, body, sentAt: "2026-09-13" }));
  assert.deepEqual(invocationSourceMessages(messages).map(item => item.id), ["m0", "m1", "m2"]);
});

test("continuation pages preserve independent Run ids and reject cross-message evidence", async () => {
  const record = { runId: "run:one", channelId: "channel", sourceMessageId: "message" };
  const result = await request(async ({ cursor }) => ({ launches: [],
    continuations: [{ ...record, runId: cursor ? "run:two" : "run:one" }], nextCursor: cursor ? null : "next" }));
  assert.deepEqual(result.continuations.map(item => item.runId), ["run:one", "run:two"]);
  await assert.rejects(request(async () => ({ launches: [], continuations: [{ ...record, sourceMessageId: "foreign" }] })), /scope/);
  await assert.rejects(request(async () => ({ launches: [], continuations: [record], nextCursor: "again" })), /scope|ordering/);
});
const item = (id, sourceMessageId = "message") => ({ launchId: id, channelId: "channel", sourceMessageId });
const request = (fetchPage) => loadInvocationPages({ channelId: "channel", sourceMessageIds: ["message"],
  signal: new AbortController().signal, fetchPage });

test("old visible invocation messages are queried without scanning newer offscreen messages", () => {
  const messages = Array.from({ length: 150 }, (_, index) => ({ id: `m${index}`, body: "@codex:new:owner/repo", sentAt: "2026-09-13T00:00:00Z" }));
  assert.deepEqual(invocationSourceMessages(messages, ["m1", "m2"]).map(message => message.id), ["m1", "m2"]);
  assert.equal(invocationSourceMessages(messages, []).length, 0);
  assert.equal(invocationSourceMessages(messages).length, 20, "bootstrap is bounded until the virtualizer reports visibility");
});
test("all bounded pages are read, including more than 100 invocations", async () => {
  const calls = [];
  const result = await request(async (input) => {
    calls.push(input);
    return input.cursor === null ? { launches: Array.from({ length: 100 }, (_, i) => item(`a${i}`)), nextCursor: "page2" }
      : { launches: [item("a100")], rejections: [{ invocationId: "r1", channelId: "channel", sourceMessageId: "message" }], nextCursor: null };
  });
  assert.equal(result.launches.length, 101);
  assert.equal(result.rejections.length, 1);
  assert.equal(calls[1].cursor, "page2");
});
test("scope changes, duplicate rows and repeated cursors never yield a partial success", async () => {
  await assert.rejects(request(async () => ({ launches: [{ ...item("a"), channelId: "foreign" }] })), /scope/);
  await assert.rejects(request(async () => ({ launches: [item("a")], nextCursor: "again" })), /scope|ordering/);
  await assert.rejects(request(async () => ({ launches: [], nextCursor: "again" })), /pagination/);
});
test("a cancelled visible-window read does not make any request", async () => {
  const controller = new AbortController(); controller.abort(new Error("changed channel"));
  await assert.rejects(loadInvocationPages({ channelId: "channel", sourceMessageIds: ["message"], signal: controller.signal,
    fetchPage: async () => { throw new Error("must not run"); } }), /changed channel/);
});
test("an older complete response still works and large visible sets use bounded batches", async () => {
  assert.equal((await request(async () => ({ launches: [item("old")] }))).launches.length, 1);
  const sizes = [];
  const result = await loadInvocationPages({ channelId: "channel", sourceMessageIds: Array.from({ length: 101 }, (_, i) => `m${i}`),
    signal: new AbortController().signal, fetchPage: async ({ sourceMessageIds }) => {
      sizes.push(sourceMessageIds.length); return { launches: sourceMessageIds.map(id => item(id, id)), nextCursor: null };
    } });
  assert.deepEqual(sizes, [100, 1]); assert.equal(result.launches.length, 101);
});

test("cancellation while the final page is arriving discards its result", async () => {
  const controller = new AbortController();
  await assert.rejects(loadInvocationPages({ channelId: "channel", sourceMessageIds: ["message"], signal: controller.signal,
    fetchPage: async () => { controller.abort(new Error("viewer changed")); return { launches: [item("late")], nextCursor: null }; }
  }), /viewer changed/);
});


test("execution history survives independent pagination and rejects foreign or repeated evidence", async () => {
  const execution = (id, channelId = "channel", sourceMessageId = "message") => ({ id, channelId, sourceMessageId });
  const result = await request(async ({ cursor }) => ({ launches: [], executions: cursor
    ? [execution("e100")] : Array.from({ length: 100 }, (_, index) => execution(`e${index}`)),
    nextCursor: cursor ? null : "executions-only" }));
  assert.equal(result.executions.length, 101);
  for (const record of [execution("e", "foreign"), execution("e", "channel", "foreign")]) {
    await assert.rejects(request(async () => ({ launches: [], executions: [record] })), /scope/);
  }
  await assert.rejects(request(async () => ({ launches: [], executions: [execution("e")], nextCursor: "again" })), /scope|ordering/);
  await assert.rejects(request(async () => ({ launches: [], executions: Array.from({ length: 101 }, (_, index) => execution(`e${index}`)) })), /Invalid invocation page/);
});


test("target-only pages stay complete and cannot borrow another message's target", async () => {
  const target = id => ({ id, channelId: "channel", sourceMessageId: "message" });
  const result = await request(async ({ cursor }) => ({ launches: [], targets: cursor ? [target("last")]
    : Array.from({ length: 100 }, (_, index) => target(`t${index}`)), nextCursor: cursor ? null : "target-tail" }));
  assert.equal(result.targets.length, 101);
  await assert.rejects(request(async () => ({ launches: [], targets: [{ ...target("t"), channelId: "foreign" }] })), /scope/);
  await assert.rejects(request(async () => ({ launches: [], targets: [target("t")], nextCursor: "again" })), /scope|ordering/);
});

test("ordinary visible human inputs query execution evidence without waking or including agent progress", () => {
  const messages = [
    { id: "human", body: "Continue", senderKind: "user", sentAt: "2026-09-30" },
    { id: "progress", body: "Waiting for CI", senderKind: "agent", sentAt: "2026-09-30" },
  ];
  assert.deepEqual(invocationSourceMessages(messages).map(message => message.id), ["human"]);
  assert.deepEqual(invocationSourceMessages(messages, ["progress"]), []);
});

test("an Agent's stop command queries its stop receipt", () => {
  const messages = [
    { id: "stop", body: "@grok:3:stop grok:2 continues this work", senderKind: "agent", sentAt: "2026-10-06" },
    { id: "quote", body: "`@grok:3:stop`", senderKind: "agent", sentAt: "2026-10-06" },
  ];
  assert.deepEqual(invocationSourceMessages(messages).map(message => message.id), ["stop"]);
});
