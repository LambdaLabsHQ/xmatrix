import assert from "node:assert/strict";
import test from "node:test";
import * as decoding from "lib0/decoding";
import { PAGE_MESSAGE_CO_WRITE } from "@xmatrix/protocol";
import { PageAssistantOutputReceiver, parsePageAssistantOutput } from "../src/page-assistant-output.ts";
import { PageSession } from "../src/page-session.ts";

const page = "12345678-1234-1234-1234-123456789abc";
const agent = { kind: "agent", id: "writer", label: "Writer", ownerUserId: "owner", conversationId: "channel",
  runProof: { runId: "run", instanceId: "instance", executionKey: "generation" } };
const head = { body: "# Page\n\nAnchor\n", revision: 1, agentSuggestOnly: false };

async function setup(t, { native = false } = {}) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const saved = new Map();
  let persisted;
  const requests = [];
  const sessionPorts = { loadHead: async () => head, loadRevision: async () => head.body,
    commit: async () => ({ revision: 2, headRevision: 2, kind: "edit", agentSuggestOnly: false }),
    persist: async (state) => { persisted = structuredClone(state); }, broadcast: () => {},
    send: (id, bytes) => {
      const decoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(decoder) === PAGE_MESSAGE_CO_WRITE) requests.push({ id,
        ...JSON.parse(decoding.readVarString(decoder)) });
    } };
  const sessions = [];
  let session = new PageSession(sessionPorts);
  sessions.push(session);
  await session.ensureLoaded(agent);
  const join = (id) => session.connect({ id, principal: agent, canEdit: true, coWriter: true, acknowledged: true });
  if (native) join("page-socket");
  const turn = requests.find((request) => request.type === "turn");
  const target = turn ? { page, session: turn.outputSession, turn: turn.turn } : undefined;
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
    ...(target ? { target } : {}),
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
  return { ports, input: (seq, text) => ({ ...input(seq, text), startedAt }), send, writes, saved, requests,
    join, disconnect: (id) => session.disconnect(id), setCanEdit: (value) => session.setCanEdit("page-socket", value),
    undo: () => session.undoCoWriting("channel", "human"),
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

// The Page issues the binding, owns the actual writer and persists its effects;
// no mock here implements output delivery, cancellation or co-writing semantics.
test("a Page-issued turn uses acknowledged raw output, keeps undo, and cannot change its target", async (t) => {
  const h = await setup(t, { native: true });
  const text = '⟦after "Anchor"⟧\nTogether 😀';
  const result = await h.send(0, text);
  assert.equal(result.status, "accepted");
  assert.deepEqual(await h.send(0, text), result);
  const router = new PageAssistantOutputReceiver();
  const moved = h.input(1, "elsewhere");
  moved.target = { ...moved.target, session: "another-socket" };
  assert.equal((await router.receive("run-generation", moved, h.ports)).status, "rejected");
  assert.equal((await h.send(1)).status, "accepted");
  assert.equal(h.writes[0].reply.type, "answer");
  assert.equal(h.body(), "# Page\n\nAnchor\n\nTogether 😀\n");
  assert.equal(h.undo(), "undone");
  assert.equal(h.body(), head.body);
});

test("a reconnect cannot adopt the old socket's turn even when its turn number repeats", async (t) => {
  const h = await setup(t, { native: true });
  h.disconnect("page-socket");
  h.join("replacement-socket");
  const turns = h.requests.filter((request) => request.type === "turn");
  assert.equal(turns[0].turn, turns[1].turn, "both writers started on the same clock tick");
  assert.equal((await h.send(0, '⟦after "Anchor"⟧Stale')).status, "rejected");
  assert.equal(h.body(), head.body);
});

test("cancelling a lost Page acknowledgement stops its writer and fences the delayed operation", async (t) => {
  const h = await setup(t, { native: true });
  const write = h.ports.write;
  let delayed;
  h.ports.write = async (page, operation) => {
    const result = await write(page, operation);
    if (operation.reply.type === "delta") { delayed = operation; throw new Error("lost response"); }
    return result;
  };
  await assert.rejects(h.send(0, '⟦after "Anchor"⟧Late'), /lost response/u);
  h.ports.write = write;
  const cancel = { ...h.input(0), type: "cancel" };
  const router = new PageAssistantOutputReceiver();
  assert.equal((await router.receive("run-generation", cancel, h.ports)).status, "accepted");
  assert.ok(h.requests.some((request) => request.type === "interrupt" && request.turn === cancel.target.turn));
  assert.equal((await write(page, delayed)).status, "rejected");
  assert.equal((await h.send(1, "late suffix")).status, "unknown");
  assert.equal(h.body(), head.body);
});

test("permission changes stop an adopted Page turn before accepting more assistant text", async (t) => {
  const h = await setup(t, { native: true });
  assert.equal((await h.send(0, '⟦after "Anchor"⟧First')).status, "accepted");
  const before = h.body();
  h.setCanEdit(false);
  assert.equal((await h.send(1, " more")).status, "rejected");
  assert.equal(h.body(), before);
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
