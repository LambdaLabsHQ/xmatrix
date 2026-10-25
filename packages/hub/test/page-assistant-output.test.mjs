import assert from "node:assert/strict";
import test from "node:test";
import { PageAssistantOutputReceiver, parsePageAssistantOutput } from "../src/page-assistant-output.ts";
import { PageSession } from "../src/page-session.ts";

const page = "12345678-1234-1234-1234-123456789abc";
const agent = { kind: "agent", id: "writer", label: "Writer", ownerUserId: "owner", conversationId: "channel",
  runProof: { runId: "run", instanceId: "instance", executionKey: "generation" } };
const head = { body: "# Page\n\nAnchor\n", revision: 1, agentSuggestOnly: false };

async function setup(t) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const saved = new Map();
  let persisted;
  const sessionPorts = { loadHead: async () => head, loadRevision: async () => head.body,
    commit: async () => ({ revision: 2, headRevision: 2, kind: "edit", agentSuggestOnly: false }),
    persist: async (state) => { persisted = structuredClone(state); }, send: () => {}, broadcast: () => {} };
  const sessions = [];
  let session = new PageSession(sessionPorts);
  sessions.push(session);
  await session.ensureLoaded(agent);
  t.after(() => sessions.forEach((s) => s.destroy()));
  const writes = [];
  const ports = {
    load: async (key) => structuredClone(saved.get(key)),
    save: async (key, state) => saved.set(key, structuredClone(state)),
    admit: async () => true,
    write: async (target, write) => {
      assert.equal(target, page);
      writes.push(structuredClone(write));
      return session.output(agent, write);
    },
  };
  const input = (seq, text) => ({ stream: "model-turn", startedAt: now, seq,
    type: text === undefined ? "end" : "text", ...(text === undefined ? {} : { text }) });
  const startedAt = now;
  let receiver = new PageAssistantOutputReceiver();
  async function send(seq, text) {
    const event = { ...input(seq, text), startedAt };
    for (let retry = 0; retry < 100; retry++) {
      const ack = await receiver.receive("run-generation", event, ports);
      if (ack.status !== "limited") return ack;
      now += Math.max(1, ack.retryAfterMs ?? 0);
    }
    throw new Error("output did not drain");
  }
  return { ports, input: (seq, text) => ({ ...input(seq, text), startedAt }), send, writes, saved,
    body: () => session.markdown(),
    restartRouter: () => { receiver = new PageAssistantOutputReceiver(); },
    restartPage: async () => {
      session.destroy();
      session = new PageSession(sessionPorts);
      sessions.push(session);
      await session.ensureLoaded(agent, persisted);
    },
    advance: (ms) => { now += ms; },
  };
}

test("assistant markers split at any character write one page through acknowledged, rate-limited input", async (t) => {
  const h = await setup(t);
  const text = `ordinary reply ⟦write page:${page}⟧⟦after "Anchor"⟧\nHello 😀⟦/write⟧ ordinary again`;
  let seq = 0;
  for (const char of text) {
    const ack = await h.send(seq, char);
    assert.equal(ack.status, "accepted");
    assert.equal(ack.at, 1);
    assert.deepEqual(await h.send(seq, char), ack, "a lost ack never replays an effect");
    if (seq % 7 === 0) h.restartRouter();
    seq++;
  }
  assert.equal((await h.send(seq)).status, "accepted");
  assert.equal(h.body(), "# Page\n\nAnchor\n\nHello 😀\n");
  assert.ok(h.writes.filter((write) => write.reply.type === "delta").every((write) => [...write.reply.text].length <= 10));
});

test("lost Page RPC acknowledgements are retried against the receipt, including a cold router", async (t) => {
  const h = await setup(t);
  const original = h.ports.write;
  let lose = true;
  h.ports.write = async (...args) => {
    const result = await original(...args);
    if (lose && args[1].reply.type === "delta") { lose = false; throw new Error("response lost"); }
    return result;
  };
  const text = `⟦write page:${page}⟧⟦after "Anchor"⟧\nOnly once`;
  await assert.rejects(h.send(0, text), /response lost/u);
  h.restartRouter();
  assert.equal((await h.send(0, text)).status, "accepted");
  assert.equal((await h.send(1)).status, "accepted");
  assert.equal(h.body(), "# Page\n\nAnchor\n\nOnly once\n");
});

test("lost Page parser state yields unknown without reopening its action; cancellation fences stale deliveries", async (t) => {
  const h = await setup(t);
  assert.equal((await h.send(0, `⟦write page:${page}⟧⟦after "Anchor"⟧\nFirst`)).status, "accepted");
  const before = h.body();
  await h.restartPage();
  assert.equal((await h.send(1, " second")).status, "unknown");
  assert.equal(h.body(), before);
  const receiver = new PageAssistantOutputReceiver();
  const cancel = { ...h.input(1), type: "cancel" };
  assert.equal((await receiver.receive("run-generation", cancel, h.ports)).status, "accepted");
  assert.equal((await h.send(2, " third")).status, "unknown");
  assert.equal(h.body(), before);
});

test("foreign content, reordered output, expired streams and oversized frames cannot produce page writes", async (t) => {
  const h = await setup(t);
  assert.equal(parsePageAssistantOutput({ ...h.input(0), type: "tool_result", text: "ignored" }), null);
  assert.equal(parsePageAssistantOutput(h.input(0, "😀".repeat(1025))), null);
  assert.equal((await h.send(1, `⟦write page:${page}⟧`)).status, "rejected");
  assert.equal((await h.send(0, "plain assistant text")).status, "accepted");
  assert.equal((await h.send(0, `⟦write page:${page}⟧`)).status, "rejected");
  h.advance(31 * 60_000);
  assert.equal((await h.send(1, "too late")).status, "rejected");
  assert.deepEqual(h.writes, []);
});

test("local image policy is applied only to page content, preserving code examples and public images", async (t) => {
  const h = await setup(t);
  assert.deepEqual((await h.send(0, "ordinary reply ![local](/tmp/outside.png)")).problems, []);
  await h.send(1, `⟦write page:${page}⟧⟦after "Anchor"⟧\n![no](/tmp/no.png) ![yes](https://example.com/yes.png)\n\n\`![sample](/tmp/example.png)\``);
  const outcome = await h.send(2);
  assert.equal(outcome.status, "accepted");
  assert.match(outcome.problems.join("\n"), /Images of local files/u);
  assert.doesNotMatch(h.body(), /no\.png/u);
  assert.match(h.body(), /https:\/\/example.com\/yes.png/u);
  assert.match(h.body(), /`!\[sample\]\(\/tmp\/example.png\)`/u);
});
