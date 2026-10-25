import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { DurableObject } from "cloudflare:workers";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  PAGE_DOCUMENT_FRAGMENT, PAGE_MESSAGE_AWARENESS, PAGE_MESSAGE_NOTICE, PAGE_MESSAGE_SYNC, PageSession,
  PageSessionConflict, pageFragmentMarkdown, setPageFragmentMarkdown,
} from "../src/page-session.ts";
import { CO_WRITER_KEEP_UP_MS, CO_WRITER_PAUSE_MS, CO_WRITER_TURN_MS, CO_WRITER_WRITE_EVERY_MS } from "../src/page-co-writer.ts";
import { PAGE_MESSAGE_CO_WRITE } from "@xmatrix/protocol";
import { canonicalPageMarkdown as canonical, markdownToPageDoc, pageDocToMarkdown, pageSchema } from "@xmatrix/protocol/page-document";
import { absolutePositionToRelativePosition, initProseMirrorDoc, updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { RelayPageSession } from "../src/page-session-do.ts";
import { PageControlError, PostgresPageRepository } from "@xmatrix/db";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const HEAD = "# Project\n\n## Status\n\nIn progress\n\n## Notes\n\nnone\n";
const human = (id) => ({ kind: "user", id, label: id });
const agent = { kind: "agent", id: "agent-1", label: "claude:1", conversationId: "conv-1",
  runProof: { runId: "r", instanceId: "i", executionKey: "k" } };

/**
 * A person's edits, written as markdown offsets for brevity: each becomes the
 * structural update the editor would make to the page's document.
 */
function documentText(fragment) {
  const edit = (change) => setPageFragmentMarkdown(fragment, change(pageFragmentMarkdown(fragment)), "client");
  return {
    toString: () => pageFragmentMarkdown(fragment),
    get length() { return pageFragmentMarkdown(fragment).length; },
    insert: (index, value) => edit((text) => text.slice(0, index) + value + text.slice(index)),
    delete: (index, count) => edit((text) => text.slice(0, index) + text.slice(index + count)),
  };
}

const cleanups = [];
test.afterEach(() => { while (cleanups.length) cleanups.pop()(); });

function harness({ head = HEAD, suggestOnly = false, commit } = {}) {
  const revisions = new Map([[1, head]]);
  let headRevision = 1;
  const commits = [];
  const clients = new Map();
  const notices = [];
  const persisted = [];
  const ports = {
    loadHead: async () => ({ revision: headRevision, body: revisions.get(headRevision), agentSuggestOnly: suggestOnly }),
    loadRevision: async (_p, revision) => revisions.get(revision),
    commit: commit ?? (async (principal, input) => {
      if (input.baseRevision !== headRevision && !(principal.kind === "agent" && suggestOnly)) {
        throw new PageSessionConflict(headRevision, revisions.get(headRevision));
      }
      const revision = Math.max(...revisions.keys()) + 1;
      revisions.set(revision, input.body);
      const kind = principal.kind === "agent" && suggestOnly ? "suggestion" : "edit";
      if (kind === "edit") headRevision = revision;
      commits.push({ principal: principal.id, kind, ...input });
      return { revision, kind, headRevision, agentSuggestOnly: suggestOnly };
    }),
    persist: async (state) => { persisted.push(state); },
    send: (id, data) => clients.get(id)?.deliver(data),
    broadcast: (data, except) => { for (const [id, client] of clients) if (id !== except) client.deliver(data); },
    sleep: async () => {},
  };
  const session = new PageSession(ports);
  cleanups.push(() => session.destroy());
  function connect(id, principal, canEdit = true, doc = new Y.Doc()) {
    const text = documentText(doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT));
    const awareness = new awarenessProtocol.Awareness(doc);
    cleanups.push(() => { awareness.destroy(); doc.destroy(); });
    const client = {
      doc, text, awareness,
      deliver(data) {
        const decoder = decoding.createDecoder(data);
        const type = decoding.readVarUint(decoder);
        if (type === PAGE_MESSAGE_SYNC) {
          const reply = encoding.createEncoder();
          encoding.writeVarUint(reply, PAGE_MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, reply, doc, "server");
          if (encoding.length(reply) > 1) session.receive(id, encoding.toUint8Array(reply));
        } else if (type === PAGE_MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), "server");
        } else if (type === PAGE_MESSAGE_NOTICE) {
          notices.push({ to: id, ...JSON.parse(decoding.readVarString(decoder)) });
        }
      },
    };
    doc.on("update", (update, origin) => {
      if (origin === "server") return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, PAGE_MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      session.receive(id, encoding.toUint8Array(encoder));
    });
    clients.set(id, client);
    session.connect({ id, principal, canEdit });
    // The client's own step 1 completes the handshake.
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, PAGE_MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(step1, doc);
    session.receive(id, encoding.toUint8Array(step1));
    return client;
  }
  function moveHead(body) {
    const revision = Math.max(...revisions.keys()) + 1;
    revisions.set(revision, body);
    headRevision = revision;
  }
  return { session, ports, commits, persisted, connect, notices, revisions, moveHead };
}

/** Load the session as ann and connect her editor. */
async function annConnected(h) {
  await h.session.ensureLoaded(human("ann"));
  return h.connect("c-ann", human("ann"));
}

/** A real live document and a controllable transport clock for output receipts. */
async function outputSession(t) {
  const clock = { now: Date.now() };
  t.mock.method(Date, "now", () => clock.now);
  const h = harness();
  const ann = await annConnected(h);
  return { h, ann, clock };
}

test("Hub output retries acknowledge one document change, including after the Page session restarts", async (t) => {
  const { h, ann, clock } = await outputSession(t);
  const expiresAt = clock.now + 60_000;
  let seq = 0;
  let at = 0;
  const send = (reply) => h.session.output(agent, { stream: "reply-1", seq, expiresAt, reply });
  assert.equal((await send({ type: "write", turn: 1 })).status, "accepted");
  seq++;
  for (const text of "⟦after \"none\"⟧\nhello 😀".match(/.{1,5}/gsu)) {
    clock.now += 500;
    const reply = { type: "delta", turn: 1, text, paced: { at } };
    const receipt = await send(reply);
    assert.equal(receipt.status, "accepted");
    const before = ann.text.toString();
    assert.deepEqual(await send(reply), receipt, "a lost response is replayed without a second application");
    assert.equal(ann.text.toString(), before);
    at += [...text].length;
    seq++;
  }
  assert.match(ann.text.toString(), /none\n\nhello 😀\n$/u);
  const end = { stream: "reply-1", seq, expiresAt, reply: { type: "done", turn: 1, paced: { at } } };
  const receipt = await h.session.output(agent, end);
  const saved = h.persisted.at(-1);
  const restored = harness();
  await restored.session.ensureLoaded(agent, saved);
  assert.deepEqual(await restored.session.output(agent, end), receipt);
  assert.equal(restored.session.markdown(), ann.text.toString());
  assert.equal((await restored.session.output(agent, { ...end, seq: seq + 1,
    reply: { type: "delta", turn: 1, text: "late", paced: { at } } })).status, "unknown", "lost parser and anchors never restart a write");
  assert.equal((await h.session.output(agent, { ...end, reply: { type: "failed", turn: 1, paced: { at } } })).status,
    "rejected", "the same sequence cannot mean different content");
});

test("Hub output keeps refused text at the sender and never applies beyond the last confirmed sequence", async (t) => {
  const { h, clock } = await outputSession(t);
  const base = { stream: "reply-2", expiresAt: clock.now + 60_000 };
  await h.session.output(agent, { ...base, seq: 0, reply: { type: "write", turn: 1 } });
  await h.session.output(agent, { ...base, seq: 1,
    reply: { type: "delta", turn: 1, text: "⟦after ", paced: { at: 0 } } });
  await h.session.output(agent, { ...base, seq: 2,
    reply: { type: "delta", turn: 1, text: '"none"⟧abc', paced: { at: 7 } } });
  const next = { ...base, seq: 3, reply: { type: "delta", turn: 1, text: "defghijklm", paced: { at: 17 } } };
  const refused = await h.session.output(agent, next);
  assert.equal(refused.status, "limited");
  assert.equal(refused.at, 17);
  assert.match(h.session.markdown(), /abc\n$/u);
  assert.equal((await h.session.output(agent, { ...next, seq: 4 })).status, "out_of_order");
  clock.now += 500;
  assert.equal((await h.session.output(agent, next)).status, "accepted");
  assert.match(h.session.markdown(), /abcdefghijklm\n$/u);
});

test("a failed persistence leaves the output unknown instead of allowing a replay", async () => {
  const h = harness();
  await annConnected(h);
  const write = { stream: "reply-3", expiresAt: Date.now() + 60_000, seq: 0, reply: { type: "write", turn: 1 } };
  const persist = h.ports.persist;
  h.ports.persist = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(h.session.output(agent, write), /storage unavailable/u);
  h.ports.persist = persist;
  assert.equal((await h.session.output(agent, write)).status, "unknown");
  assert.equal(h.session.markdown(), HEAD);
});

test("Page output rechecks Run authority before serving even a cached receipt", async (t) => {
  const h = harness();
  await annConnected(h);
  let mayEdit = true;
  const checks = [];
  t.mock.method(PostgresPageRepository.prototype, "access", async (input) => {
    checks.push(input);
    return { canEdit: mayEdit, agentSuggestOnly: false };
  });
  const object = Object.create(RelayPageSession.prototype);
  Object.assign(object, { session: h.session, tickets: new Map(), spaceId: "space", pageId: "page",
    rehydrated: Promise.resolve(),
    env: { RELAY_POSTGRES_SHARD_ID: "test", RELAY_POSTGRES: { connectionString: "postgresql://localhost/unused" } },
    ctx: { getWebSockets: () => [], storage: { put: async () => {}, get: async () => undefined } } });
  const write = { stream: "authorized-output", expiresAt: Date.now() + 60_000, seq: 0,
    reply: { type: "write", turn: 1 } };
  const request = (principal = agent, event = write) => new Request("https://page-session/internal/output", {
    method: "POST", body: JSON.stringify({ spaceId: "space", pageId: "page", principal, write: event }) });
  assert.equal((await object.fetch(request())).status, 200);
  mayEdit = false;
  assert.equal((await object.fetch(request())).status, 403, "revocation wins over a delivery receipt");
  assert.equal(checks.length, 2);
  assert.deepEqual(checks[0].principal.runProof, agent.runProof);
  assert.equal((await object.fetch(request(human("owner")))).status, 400, "human sessions cannot impersonate assistant output");
  assert.equal((await object.fetch(request(agent, { ...write, seq: 1,
    reply: { type: "delta", turn: 1, text: "too many characters", paced: { at: 0 } } }))).status, 400);
  assert.equal(checks.length, 2, "malformed writes never reach the page authority");
  assert.equal(h.session.markdown(), HEAD);
});

test("an output receipt persists every applied character without waiting for a display timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = harness();
  await annConnected(h);
  const base = { stream: "immediate", expiresAt: now + 60_000 };
  await h.session.output(agent, { ...base, seq: 0, reply: { type: "write", turn: 1 } });
  let seq = 1;
  let at = 0;
  for (const text of ['⟦after ', '"none"⟧', 'a', 'b']) {
    const result = await h.session.output(agent, { ...base, seq, reply: { type: "delta", turn: 1, text, paced: { at } } });
    assert.equal(result.status, "accepted");
    seq++;
    at += [...text].length;
  }
  assert.match(h.session.markdown(), /ab\n$/u);
  const restored = harness();
  await restored.session.ensureLoaded(agent, h.persisted.at(-1));
  assert.match(restored.session.markdown(), /ab\n$/u, "the confirmed text survived before any display timer fired");
});

test("undo selects the latest acknowledged stream in a conversation", async (t) => {
  const { h, clock } = await outputSession(t);
  for (const stream of ["first", "second"]) {
    const base = { stream, expiresAt: clock.now + 60_000 };
    await h.session.output(agent, { ...base, seq: 0, reply: { type: "write", turn: 1 } });
    let seq = 1;
    let at = 0;
    for (const text of `⟦after "none"⟧\n${stream}`.match(/.{1,5}/gsu)) {
      clock.now += 500;
      assert.equal((await h.session.output(agent, { ...base, seq, reply: { type: "delta", turn: 1, text,
        paced: { at } } })).status, "accepted");
      seq++;
      at += [...text].length;
    }
    await h.session.output(agent, { ...base, seq, reply: { type: "done", turn: 1, paced: { at } } });
  }
  assert.match(h.session.markdown(), /second\n\nfirst/u);
  assert.equal(h.session.undoCoWriting("conv-1", "ann"), "undone");
  assert.match(h.session.markdown(), /first/u);
  assert.doesNotMatch(h.session.markdown(), /second/u);
});

/** The Agent's edit of the page's head: "none" becomes "some". */
function editAsAgent(h) {
  return h.session.submitEdit(agent, { baseRevision: 1, body: HEAD.replace("none", "some"), conversationIds: [] });
}

test("co-editors see each other's edits and an idle commit is authored by everyone who edited", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const bob = h.connect("c-bob", human("bob"));
  assert.equal(ann.text.toString(), HEAD);
  ann.text.insert(HEAD.indexOf("none"), "ship it, ");
  bob.text.insert(bob.text.length, "\n## Links\n");
  assert.equal(ann.text.toString(), bob.text.toString(), "both replicas converge");
  const result = await h.session.commit();
  assert.equal(result.revision, 2);
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].body, ann.text.toString());
  assert.deepEqual([h.commits[0].principal, ...h.commits[0].coAuthors.map((a) => a.id)].sort(), ["ann", "bob"]);
  assert.deepEqual(h.commits[0].blockIds.sort(), ["links", "notes"]);
  assert.ok(h.notices.some((n) => n.type === "committed" && n.revision === 2));
  assert.equal(await h.session.commit(), null, "nothing pending, nothing committed");
});

test("a page made from the document its author is writing starts from it, and their editor merges into it", async () => {
  // The author's editor, before the page exists: what they wrote first is what the page is made from.
  const doc = new Y.Doc();
  const text = documentText(doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT));
  text.insert(0, "Plans\n");
  const started = Y.encodeStateAsUpdate(doc);
  const h = harness({ head: canonical(text.toString()) });
  await h.session.ensureLoaded(human("ann"), null, started);
  // They go on writing while the page is made, then the same editor joins its session.
  text.insert(text.length, "\nWhat we do next\n");
  const ann = h.connect("c-ann", human("ann"), true, doc);
  const bob = h.connect("c-bob", human("bob"));
  assert.equal(ann.text.toString(), canonical("Plans\n\nWhat we do next\n"), "nothing is written twice");
  assert.equal(bob.text.toString(), ann.text.toString());
  const result = await h.session.commit();
  assert.equal(result.revision, 2);
  assert.equal(h.commits[0].body, ann.text.toString());
});

test("words typed under a new page's name while it is being made are kept", async () => {
  // Named, the page opens with its heading and an empty line to write on; the page is made from that.
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT);
  const named = markdownToPageDoc("# Plans\n");
  updateYFragment(doc, fragment, named.copy(named.content.addToEnd(pageSchema.nodes.paragraph.create())),
    { mapping: new Map(), isOMark: new Map() });
  const started = Y.encodeStateAsUpdate(doc);
  const h = harness({ head: canonical(pageFragmentMarkdown(fragment)) });
  await h.session.ensureLoaded(human("ann"), null, started);
  // They type on that empty line before their editor reaches the session.
  documentText(fragment).insert(pageFragmentMarkdown(fragment).length, "\nWhat we do next\n");
  const ann = h.connect("c-ann", human("ann"), true, doc);
  assert.equal(ann.text.toString(), canonical("# Plans\n\nWhat we do next\n"));
  assert.equal(h.connect("c-bob", human("bob")).text.toString(), ann.text.toString());
});

test("a read-only connection syncs but cannot write", async () => {
  const h = harness();
  await h.session.ensureLoaded(human("ann"));
  const viewer = h.connect("c-view", human("vic"), false);
  viewer.text.insert(0, "vandalism ");
  assert.equal(h.session.markdown(), HEAD);
  assert.equal(await h.session.commit(), null);
});

test("an Agent edit merges with human edits, streams in under its cursor and commits separately", async () => {
  const h = harness();
  const ann = await annConnected(h);
  ann.text.insert(HEAD.indexOf("none"), "human note, ");
  const agentBody = HEAD.replace("In progress", "Shipped");
  const result = await h.session.submitEdit(agent, { baseRevision: 1, body: agentBody, conversationIds: ["conv-1"] });
  assert.equal(h.commits.length, 2, "the pending human edit commits under its own author first");
  assert.equal(h.commits[0].principal, "ann");
  assert.equal(h.commits[1].principal, "agent-1");
  assert.deepEqual(h.commits[1].conversationIds, ["conv-1"]);
  assert.deepEqual(h.commits[1].blockIds, ["status"]);
  assert.match(ann.text.toString(), /Shipped/u);
  assert.match(ann.text.toString(), /human note, none/u);
  assert.equal(result.headRevision, 3);
  const agentState = [...ann.awareness.getStates().values()].find((state) => state?.user?.kind === "agent");
  assert.equal(agentState.user.name, "claude:1");
  assert.equal(agentState.block, "status");
  // The Agent's text is written under its awareness id, so readers can mark it as the Agent's.
  const agentClient = [...ann.awareness.getStates()].find(([, state]) => state?.user?.kind === "agent")[0];
  assert.ok(ann.doc.store.clients.has(agentClient), "the Agent's text carries its awareness id");
  assert.notEqual(h.session.doc.clientID, agentClient, "the session writes as itself again afterwards");
});

// What a reader sees of an Agent's committed edit is what was committed (pages-live-document.md §2): never a
// replay of it, word after word, while the head already holds all of it.
test("readers get an Agent's committed edit whole, in one update, and people's typing meanwhile is kept", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const seen = [];
  ann.doc.on("update", () => seen.push(ann.text.toString()));
  const agentBody = HEAD.replace("In progress", "Shipped to every Space on Friday, behind one switch, with docs and a video");
  await h.session.submitEdit(agent, { baseRevision: 1, body: agentBody, conversationIds: ["conv-1"] });
  assert.deepEqual(seen, [agentBody], "one update, and it is the committed page");
  assert.equal(h.revisions.get(2), agentBody);
  ann.text.insert(ann.text.toString().indexOf("none"), "human note, ");
  assert.match(ann.text.toString(), /with docs and a video/u);
  assert.match(ann.text.toString(), /human note, none/u, "what a person types stays");
  const agentState = [...ann.awareness.getStates().values()].find((state) => state?.user?.kind === "agent");
  assert.equal(agentState.activity, "editing", "it is done writing");
  assert.equal(agentState.wrote?.length, 1, "what it changed is marked as its own while fresh");
});

// Text-only coverage cannot catch document normalization changing the merge baseline.
test("structural edits reach their committed document and keep a person's typing", async () => {
  for (const replacement of [
    "| Name | Status |\n| --- | --- |\n| Web | shipped today |",
    "- first item\n- second item with more words",
    "```ts\nconst shipped = true;\n```",
  ]) {
    const h = harness();
    const ann = await annConnected(h);
    const body = HEAD.replace("In progress", replacement);
    const started = new Promise((resolve) => ann.doc.once("update", resolve));
    const editing = h.session.submitEdit(agent, { baseRevision: 1, body, conversationIds: ["conv-1"] });
    await started;
    ann.text.insert(ann.text.toString().indexOf("none"), "human note, ");
    await editing;
    assert.equal(ann.text.toString(), body.replace("none", "human note, none"));
    await h.session.commit();
    assert.equal(h.commits.at(-1).principal, "ann");
    assert.equal(h.commits.at(-1).body, ann.text.toString());
  }
});

// A session kept by an earlier version could stop while a committed edit was still being typed in; restored
// now, the rest goes in at once, around a person's pending edit, without another commit.
test("a session stored mid-typing by an earlier version puts the rest of the committed edit in at once", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const body = HEAD.replace("In progress", "Shipped to every Space");
  await h.session.submitEdit(agent, { baseRevision: 1, body, conversationIds: ["conv-1"] });
  // What an earlier version left: the head holds the edit, the live text only its first word.
  let paragraph = null;
  const find = (node) => {
    if (node instanceof Y.XmlText) { if (node.toString().includes("Shipped to every Space")) paragraph = node; return; }
    node.forEach?.((child) => find(child));
  };
  find(h.session.fragment);
  const at = "Shipped".length;
  h.session.doc.transact(() => paragraph.delete(at, " to every Space".length), "server");
  ann.text.insert(ann.text.toString().indexOf("none"), "human note, ");
  const state = { runs: [{ at: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(paragraph, at, -1)),
    words: [" ", "to", " ", "every", " ", "Space"].map((text) => ({ text, attrs: {} })), block: "status" }] };
  const interrupted = { ...h.persisted.at(-1), typing: [{ clientId: 1234567, state }] };
  const resumed = new PageSession(h.ports);
  cleanups.push(() => resumed.destroy());
  await resumed.ensureLoaded(human("ann"), interrupted);
  assert.equal(resumed.markdown(), body.replace("none", "human note, none"));
  assert.equal(h.commits.length, 1, "recovering it does not repeat the Agent's commit");
  assert.equal(h.persisted.at(-1).typing, undefined, "nothing is kept to type");
  await resumed.commit();
  assert.equal(h.commits.at(-1).principal, "ann");
  assert.equal(h.commits.at(-1).body, resumed.markdown());
});

test("two Agents' edits and a person's commit at the same time all end on the page", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const codex = { ...agent, id: "agent-2", label: "codex:1", conversationId: "conv-2" };
  const long = "written by one of two Agents at the same time, word after word after word";
  const first = h.session.submitEdit(agent, { baseRevision: 1, body: HEAD.replace("In progress", `Status ${long}`),
    conversationIds: ["conv-1"] });
  const second = h.session.submitEdit(codex, { baseRevision: 1, body: HEAD.replace("none", `Notes ${long}`),
    conversationIds: ["conv-2"] });
  ann.text.insert(0, "Hi ");
  await h.session.commit();
  await Promise.all([first, second]);
  const final = ann.text.toString();
  assert.match(final, /Status written[^\n]*after word\n/u);
  assert.match(final, /Notes written[^\n]*after word\n/u);
  assert.match(final, /Hi /u, "and the person's word is there");
  assert.ok(h.commits.some((c) => c.principal === "ann"), "the person's edit committed");
  assert.equal(await h.session.commit(), null, "nothing is left pending");
  assert.equal(h.session.markdown(), head(h));
});

const LIST = "# Launch\n\n## Workstreams\n\n- Web · Claude · in progress\n- Mobile · Codex · in progress\n- Video · Cursor · not started\n";
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const as = (n, label) => ({ ...agent, id: `agent-${n}`, label, conversationId: `conv-${n}` });
const head = (h) => h.revisions.get(Math.max(...h.revisions.keys()));
/** Every document a reader holds while Agents type, as it reads. */
function frames(client) {
  const seen = [];
  client.doc.on("update", () => seen.push(yXmlFragmentToProseMirrorRootNode(client.doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT), pageSchema)));
  return seen;
}

// A committed edit reaches a reader in one update: no moment of it a Markdown parser reads otherwise, and
// no moment that is not the committed page.
test("an Agent's edit reaches a reader in one update that reads back from Markdown as itself", async () => {
  for (const replacement of [
    "Shipped **behind one switch** with [the launch docs](https://xmatrix.sh/docs) and `xmatrix page edit` *today*",
    "In progress\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter the code.",
    "| Area | Owner | State |\n| --- | --- | --- |\n| Web | Claude | merged |\n| Mobile | Codex | in review |",
    `Shipped.\n\n## Plan\n\n${Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ")}\n\n- one\n- two with more\n  - nested`,
    "会议马上开始，请大家准备好材料。\n\n- 第一项：Web 已上线",
  ]) {
    const h = harness();
    const ann = await annConnected(h);
    const seen = frames(ann);
    const body = canonical(HEAD.replace("In progress", replacement));
    await h.session.submitEdit(agent, { baseRevision: 1, body, conversationIds: ["conv-1"] });
    assert.equal(ann.text.toString(), body, replacement);
    assert.equal(h.session.markdown(), head(h));
    assert.equal(seen.length, 1, `${replacement}: one update`);
    assert.equal(pageDocToMarkdown(seen[0]), body, replacement);
    assert.ok(markdownToPageDoc(pageDocToMarkdown(seen[0])).eq(seen[0]), replacement);
  }
});

test("an Agent's edit reads the page a few times in all, and stores nothing still to write", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const reads = { count: 0 };
  const markdown = h.session.markdown.bind(h.session);
  h.session.markdown = () => { reads.count++; return markdown(); };
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  await h.session.submitEdit(agent, { baseRevision: 1, body: HEAD.replace("In progress", words), conversationIds: [] });
  assert.match(ann.text.toString(), /word199/u);
  assert.ok(reads.count <= 8, `the page was read ${reads.count} times`);
  assert.ok(h.persisted.every((state) => !state.typing), "nothing is stored to type later");
});

test("three Agents edit neighbouring lines of one list at once, each from the same revision", async () => {
  const h = harness({ head: LIST });
  const ann = await annConnected(h);
  const edits = [
    [as(1, "claude:1"), "Web · Claude · in progress", "Web · Claude · merged, live in v1.0.464 with presence and carets"],
    [as(2, "codex:1"), "Mobile · Codex · in progress", "Mobile · Codex · merged, TestFlight 2.4 with faces beside lines"],
    [as(3, "cursor:1"), "Video · Cursor · not started", "Video · Cursor · done, on the launch page with a 1080p cut"],
  ];
  await Promise.all(edits.map(([who, from, to]) =>
    h.session.submitEdit(who, { baseRevision: 1, body: LIST.replace(from, to), conversationIds: [] })));
  const final = ann.text.toString();
  for (const [, , to] of edits) assert.match(final, new RegExp(to.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.equal(final, head(h));
});

test("a person typing in the paragraph an Agent just rewrote keeps both their words", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const body = HEAD.replace("In progress", "In progress and then shipped to every Space on Friday behind one switch");
  const editing = h.session.submitEdit(agent, { baseRevision: 1, body, conversationIds: [] });
  await tick(8);
  ann.text.insert(ann.text.toString().indexOf("In progress"), "Now: ");
  await editing;
  assert.equal(ann.text.toString(), body.replace("In progress", "Now: In progress"));
  await h.session.commit();
  assert.equal(h.commits.at(-1).principal, "ann");
  assert.equal(head(h), ann.text.toString(), "the person's commit holds the Agent's words too");
});

test("an Agent's edit that rewrites another's line just after it ends as the head", async () => {
  const h = harness({ head: LIST });
  const ann = await annConnected(h);
  const claude = LIST.replace("Web · Claude · in progress", "Web · Claude · merged, live in v1.0.464 with presence and carets");
  const first = h.session.submitEdit(as(1, "claude:1"), { baseRevision: 1, body: claude, conversationIds: [] });
  await tick(6);
  ann.text.insert(0, "Hi ");
  await h.session.commit();
  const second = h.session.submitEdit(as(2, "codex:1"), { baseRevision: 2,
    body: claude.replace("merged, live in v1.0.464 with presence and carets", "reverted by Codex")
      .replace("Mobile · Codex · in progress", "Mobile · Codex · merged"), conversationIds: [] });
  await Promise.all([first, second]);
  assert.match(head(h), /Web · Claude · reverted by Codex\n- Mobile · Codex · merged\n/u);
  assert.equal(ann.text.toString(), head(h));
  assert.equal(h.session.markdown(), head(h));
});

test("two Agents changing the same words of one revision still conflict", async () => {
  const h = harness();
  await annConnected(h);
  await h.session.submitEdit(as(1, "claude:1"), { baseRevision: 1, body: HEAD.replace("In progress", "Shipped"), conversationIds: [] });
  await assert.rejects(h.session.submitEdit(as(2, "codex:1"), { baseRevision: 1, body: HEAD.replace("In progress", "Blocked"),
    conversationIds: [] }), PageSessionConflict);
});

test("committed notices arrive in revision order when Agents edit at once", async () => {
  const h = harness({ head: LIST });
  await annConnected(h);
  const long = `Web · Claude · ${Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ")}`;
  await Promise.all([
    h.session.submitEdit(as(1, "claude:1"), { baseRevision: 1, body: LIST.replace("Web · Claude · in progress", long), conversationIds: [] }),
    h.session.submitEdit(as(2, "codex:1"), { baseRevision: 1, body: LIST.replace("Mobile · Codex · in progress", "Mobile · Codex · merged"),
      conversationIds: [] }),
  ]);
  const heads = h.notices.filter((notice) => notice.type === "committed" && notice.to === "c-ann").map((notice) => notice.headRevision);
  assert.deepEqual(heads, [...heads].sort((a, b) => a - b));
  assert.equal(heads.length, 2);
});

test("a session restored with text nobody typed reads as its committed page; a person's pending text stays", async () => {
  for (const personTyped of [false, true]) {
    const h = harness();
    const ann = await annConnected(h);
    if (personTyped) ann.text.insert(HEAD.indexOf("none"), "ann's draft, ");
    // What an Agent's edit could leave when it was not written in whole: text no person typed.
    setPageFragmentMarkdown(h.session.fragment, `${h.session.markdown()}\n\`\`\`\n`, "agent:left-over");
    await tick(0);
    const restored = new PageSession(h.ports);
    cleanups.push(() => restored.destroy());
    await restored.ensureLoaded(human("ann"), h.persisted.at(-1));
    if (personTyped) assert.match(restored.markdown(), /ann's draft, none/u, "a person's pending edit is never dropped");
    else assert.equal(restored.markdown(), HEAD, "nobody typed it, so the page reads as committed");
  }
});

// Hand-written interleavings cannot cover how Agents' edits, people typing and commits fall together: many
// random ones must all end with every reader, the session and the head reading the same well-formed page.
test("random Agents' edits, people's typing and commits always end on one page everywhere", async () => {
  let seed = 61016;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const PAGE = "# Launch\n\n## Where it stands\n\nKick-off done.\n\n## Workstreams\n\n- Web · Claude · in progress\n" +
    "- Mobile · Codex · in progress\n- Video · Cursor · not started\n\n## Notes\n\nNothing yet.\n";
  const additions = ["shipped behind one switch", "**merged** with [docs](https://xmatrix.sh/d)", "`v1.0.464` is live",
    "会议马上开始", "in review, PR #566", "with faces beside every line"];
  const editOf = (text) => {
    const lines = text.split("\n");
    const at = 2 + Math.floor(random() * (lines.length - 3));
    const r = random();
    if (!lines[at].trim()) lines.splice(at, 0, "", `A new paragraph ${pick(additions)}.`);
    else if (r < 0.5) lines[at] = `${lines[at]} ${pick(additions)}`;
    else if (r < 0.8 && lines[at].startsWith("- ")) lines.splice(at + 1, 0, `- New item ${pick(additions)}`);
    else lines[at] = lines[at].replace(/\S+$/u, pick(additions));
    return lines.join("\n");
  };
  for (let round = 0; round < 25; round++) {
    const h = harness({ head: PAGE });
    const ann = await annConnected(h);
    const work = [];
    for (let n = 0; n < 3 + Math.floor(random() * 3); n++) {
      const who = as(1 + Math.floor(random() * 3), pick(["claude:1", "codex:1", "cursor:1"]));
      await tick(Math.floor(random() * 6));
      const revision = random() < 0.7 ? Math.max(...h.revisions.keys()) : 1;
      const base = h.revisions.get(revision);
      work.push(h.session.submitEdit(who, { baseRevision: revision, body: editOf(base), conversationIds: [] })
        .catch((error) => { if (!(error instanceof PageSessionConflict)) throw error; }));
      if (random() < 0.5) {
        const text = ann.text.toString();
        const words = [...text.matchAll(/[A-Za-z]+/gu)];
        const word = pick(words);
        ann.text.insert(word.index, "ann ");
      }
      if (random() < 0.3) work.push(h.session.commit());
    }
    await Promise.all(work);
    await h.session.commit();
    const final = h.session.markdown();
    assert.equal(final, head(h), `round ${round}: the session reads as the head`);
    assert.equal(ann.text.toString(), final, `round ${round}: the reader reads as the session`);
    assert.equal(canonical(final), final);
    assert.doesNotMatch(final, /^```$|^\|$/mu, `round ${round}: no stray fence or table edge`);
  }
});

test("an Agent edit answers which sections it removed and which Automations it detached", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const original = h.ports.commit;
  const detached = [{ automationId: "a-1", name: "Dependency sweep" }];
  h.ports.commit = async (principal, input) => ({ ...await original(principal, input),
    detachedAutomations: detached, attachedAutomations: [] });
  const result = await h.session.submitEdit(agent, { baseRevision: 1, body: "# Project\n\n## Status\n\nIn progress\n",
    conversationIds: [] });
  assert.deepEqual(result.removedSections, ["Notes"]);
  assert.deepEqual(result.detachedAutomations, detached);
  assert.deepEqual(result.attachedAutomations, []);
  assert.deepEqual(h.notices.find((notice) => notice.type === "committed").detachedAutomations, detached,
    "people on the page see it too");
  assert.doesNotMatch(ann.text.toString(), /## Notes/u);
});

test("an Agent edit that overlaps a newer change is refused with the current text", async () => {
  const h = harness();
  const ann = await annConnected(h);
  ann.text.delete(HEAD.indexOf("In progress"), "In progress".length);
  ann.text.insert(HEAD.indexOf("In progress"), "Blocked");
  await h.session.commit();
  await assert.rejects(
    h.session.submitEdit(agent, { baseRevision: 1, body: HEAD.replace("In progress", "Shipped"), conversationIds: [] }),
    (error) => error instanceof PageSessionConflict && /Blocked/u.test(error.body),
  );
  assert.match(h.session.markdown(), /Blocked/u);
});

test("on a suggest-only page an Agent's edit becomes a suggestion and the live text is untouched", async () => {
  const h = harness({ suggestOnly: true });
  await h.session.ensureLoaded(human("ann"));
  h.connect("c-ann", human("ann"));
  const result = await h.session.submitEdit(agent, { baseRevision: 1, body: "# Replaced\n", conversationIds: [] });
  assert.equal(result.kind, "suggestion");
  assert.equal(h.session.markdown(), HEAD);
  assert.ok(h.notices.some((n) => n.type === "suggestion"));
});

test("a head moved outside the session is merged before the session commits", async () => {
  const h = harness();
  const ann = await annConnected(h);
  // A promote landed revision 2 without passing through the session.
  h.moveHead(HEAD.replace("# Project", "# Project (renamed)"));
  ann.text.insert(ann.text.length, "\nappendix\n");
  const result = await h.session.commit();
  assert.equal(result.revision, 3);
  assert.match(ann.text.toString(), /# Project \(renamed\)/u);
  assert.match(ann.text.toString(), /appendix/u);
  assert.equal(h.commits.at(-1).baseRevision, 2, "the retry is based on the moved head");
});

test("an Agent edit after a head moved outside an idle session merges against the moved head", async () => {
  const h = harness();
  const ann = await annConnected(h);
  // A migration wrote revision 2 while nobody edited: the session has nothing pending to commit.
  const moved = `${HEAD}\n[Sweep](xmatrix:automation/a-1)\n`;
  h.moveHead(moved);
  const body = `${moved}\n[Audit](xmatrix:automation/a-2)\n`;
  const result = await h.session.submitEdit(agent, { baseRevision: 2, body, conversationIds: [] });
  assert.equal(result.headRevision, 3);
  assert.equal(h.commits.at(-1).baseRevision, 2);
  assert.match(ann.text.toString(), /xmatrix:automation\/a-1/u);
  assert.match(ann.text.toString(), /xmatrix:automation\/a-2/u);
});

test("a redaction reaches the live text without re-committing the removed content", async () => {
  const h = harness({ head: "# P\n\ntoken sk-secret\n" });
  const ann = await annConnected(h);
  ann.text.insert(ann.text.length, "more sk-secret\n");
  h.ports.loadHead = async () => ({ revision: 1, body: "# P\n\ntoken [redacted]\n", agentSuggestOnly: false });
  await h.session.reload(human("admin"), { needle: "sk-secret", replacement: "[redacted]" });
  assert.doesNotMatch(ann.text.toString(), /sk-secret/u);
  assert.ok(h.commits.every((commit) => !commit.body.includes("sk-secret")));
});

test("closing a connection removes its awareness", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const bob = h.connect("c-bob", human("bob"));
  ann.awareness.setLocalStateField("user", { name: "ann" });
  const update = awarenessProtocol.encodeAwarenessUpdate(ann.awareness, [ann.doc.clientID]);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PAGE_MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  h.session.receive("c-ann", encoding.toUint8Array(encoder));
  assert.equal(bob.awareness.getStates().get(ann.doc.clientID)?.user?.name, "ann");
  h.session.disconnect("c-ann");
  assert.equal(bob.awareness.getStates().has(ann.doc.clientID), false);
});

test("a session holds no timer, so its Durable Object can hibernate", () => {
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const before = timers();
  const h = harness();
  assert.equal(timers(), before, "a pending timer keeps the object in memory and billed");
  assert.ok(h.session);
});

test("presence nobody renewed expires when the next connection arrives", async () => {
  const h = harness();
  const ann = await annConnected(h);
  ann.awareness.setLocalStateField("user", { name: "ann" });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PAGE_MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(ann.awareness, [ann.doc.clientID]));
  h.session.receive("c-ann", encoding.toUint8Array(encoder));
  h.session.awareness.meta.get(ann.doc.clientID).lastUpdated -= awarenessProtocol.outdatedTimeout;
  const bob = h.connect("c-bob", human("bob"));
  assert.equal(h.session.awareness.getStates().has(ann.doc.clientID), false);
  assert.equal(bob.awareness.getStates().has(ann.doc.clientID), false);
});

test("an edit the repository refuses never reaches the live text", async () => {
  const h = harness();
  const ann = await annConnected(h);
  h.ports.commit = async () => { throw Object.assign(new Error("page_edit_forbidden"), { status: 403 }); };
  await assert.rejects(h.session.submitEdit(agent, { baseRevision: 1, body: "# Taken over\n", conversationIds: [] }),
    /page_edit_forbidden/u);
  assert.equal(ann.text.toString(), HEAD);
  assert.equal(h.session.markdown(), HEAD);
});

test("edits made while a commit is in flight stay pending with their own author", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const bob = h.connect("c-bob", human("bob"));
  ann.text.insert(0, "A ");
  const original = h.ports.commit;
  h.ports.commit = async (principal, input) => {
    bob.text.insert(bob.text.length, "B\n");
    h.ports.commit = original;
    return original(principal, input);
  };
  await h.session.commit();
  assert.equal(h.commits[0].principal, "ann");
  assert.doesNotMatch(h.commits[0].body, /B\n$/u, "the commit is the snapshot taken before it");
  assert.equal(h.commits[0].coAuthors.length, 0);
  assert.equal(h.session.hasPendingEdits, true);
  await h.session.commit();
  assert.equal(h.commits[1].principal, "bob");
  assert.match(h.commits[1].body, /B\n$/u);
  assert.equal(h.session.hasPendingEdits, false);
});

test("a restored session commits its pending edits under their original authors", async () => {
  const first = harness();
  const ann = await annConnected(first);
  ann.text.insert(0, "draft ");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = harness();
  await second.session.ensureLoaded(human("someone-else"), first.persisted.at(-1));
  second.connect("c-vic", human("vic"));
  await second.session.commit();
  assert.equal(second.commits[0].principal, "ann");
  assert.match(second.commits[0].body, /^draft /u);
});

test("an Agent's cursor is a Yjs relative position the editor can place", async () => {
  const h = harness();
  const ann = await annConnected(h);
  await editAsAgent(h);
  const state = [...ann.awareness.getStates().values()].find((value) => value?.user?.kind === "agent");
  const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.anchor), ann.doc);
  assert.ok(anchor?.type instanceof Y.XmlText && anchor.type.toString() === "some" && anchor.index === 4,
    "at the end of the line the Agent wrote");
  assert.equal(state.block, "notes");
});

const agentState = (client) => [...client.awareness.getStates().values()].find((value) => value?.user?.kind === "agent");

function sendAwareness(h, id, client) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PAGE_MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(client.awareness, [client.doc.clientID]));
  h.session.receive(id, encoding.toUint8Array(encoder));
}

test("an Agent's caret rests at its last edit for people who open the page later, across a restart", async () => {
  const first = harness();
  await first.session.ensureLoaded(agent);
  await editAsAgent(first);
  // The object restarts with nobody connected; a person opens the page afterwards.
  const second = harness();
  await second.session.ensureLoaded(human("ann"), first.persisted.at(-1));
  const ann = second.connect("c-ann", human("ann"));
  const state = agentState(ann);
  assert.equal(state?.activity, "editing");
  assert.equal(state.user.conversationId, "conv-1");
  const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.anchor), ann.doc);
  assert.equal(anchor?.type.toString(), "some", "still at the line it wrote");
});

test("a resting Agent caret is not reported as present once its moment has passed", async () => {
  const h = harness();
  await h.session.ensureLoaded(human("ann"));
  h.connect("c-ann", human("ann"));
  await editAsAgent(h);
  assert.deepEqual(h.session.present().map((person) => person.kind), ["agent"]);
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    assert.deepEqual(h.session.present(), []);
  } finally {
    Date.now = realNow;
  }
});

test("Agents of one harness writing from different conversations are each on the page", async () => {
  const h = harness();
  await annConnected(h);
  const other = { ...agent, id: "agent-2", conversationId: "conv-2", runProof: { ...agent.runProof, runId: "r2" } };
  h.session.agentViewing(agent, "status");
  h.session.agentViewing(other, "notes");
  assert.deepEqual(h.session.present().filter((person) => person.kind === "agent")
    .map(({ name, conversationId, blockId }) => [name, conversationId, blockId]),
  [[agent.label, "conv-1", "status"], [agent.label, "conv-2", "notes"]]);
});

test("reading another section moves an Agent's section, not the caret it left at its edit", async () => {
  const h = harness();
  const ann = await annConnected(h);
  await editAsAgent(h);
  const cursor = agentState(ann).cursor;
  h.session.agentViewing(agent, "status");
  assert.equal(agentState(ann).block, "status");
  assert.deepEqual(agentState(ann).cursor, cursor);
});

test("people's heartbeats renew a resting Agent caret before readers would drop it", async () => {
  const h = harness();
  const ann = await annConnected(h);
  await editAsAgent(h);
  const clientId = [...ann.awareness.getStates()].find(([, value]) => value?.user?.kind === "agent")[0];
  const before = ann.awareness.meta.get(clientId).clock;
  // Sixteen seconds on, the server's copy is due for renewal.
  h.session.awareness.meta.get(clientId).lastUpdated -= 16_000;
  ann.awareness.setLocalStateField("user", { name: "ann" });
  sendAwareness(h, "c-ann", ann);
  assert.ok(ann.awareness.meta.get(clientId).clock > before, "renewed to readers");
  assert.ok(agentState(ann)?.cursor, "the caret is unchanged");
});

test("a client that reconnects to a restored session merges into the same document", async () => {
  const first = harness();
  const ann = await annConnected(first);
  ann.text.insert(0, "x");
  await first.session.commit();
  // The object restarts; the browser keeps its replica and reconnects.
  const second = harness();
  await second.session.ensureLoaded(human("ann"), first.persisted.at(-1));
  const update = Y.encodeStateAsUpdate(ann.doc);
  const replica = second.connect("c-ann-2", human("ann"));
  Y.applyUpdate(replica.doc, update);
  assert.equal(second.session.markdown(), `x${HEAD}`, "not the same text twice");
  assert.equal(replica.text.toString(), `x${HEAD}`);
});

test("people's overlapping text survives an Agent edit and stays pending", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const original = h.ports.commit;
  h.ports.commit = async (principal, input) => {
    if (principal.kind === "agent") {
      const at = ann.text.toString().indexOf("In progress");
      ann.text.delete(at, "In progress".length);
      ann.text.insert(at, "HUMAN BLOCKED");
    }
    return original(principal, input);
  };
  await h.session.submitEdit(agent, { baseRevision: 1, body: HEAD.replace("In progress", "AGENT DONE"), conversationIds: [] });
  assert.match(ann.text.toString(), /HUMAN BLOCKED/u);
  assert.equal(h.session.hasPendingEdits, true, "the person's edit is still to be committed");
  assert.ok(h.commits.some((commit) => commit.principal === "agent-1" && commit.body.includes("AGENT DONE")),
    "the Agent's edit is in history");
});

test("a page opened and never edited keeps its document identity across a restart", async () => {
  const first = harness();
  const ann = await annConnected(first);
  const second = harness();
  await second.session.ensureLoaded(human("ann"), first.persisted.at(-1));
  const replica = second.connect("c-ann-2", human("ann"));
  Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(ann.doc));
  assert.equal(second.session.markdown(), HEAD);
});

test("an edit the repository turned into a suggestion never reaches the live text", async () => {
  const h = harness();
  const ann = await annConnected(h);
  h.ports.commit = async () => ({ revision: 2, kind: "suggestion", headRevision: 1 });
  const result = await h.session.submitEdit(agent, { baseRevision: 1, body: "# Replaced\n", conversationIds: [] });
  assert.equal(result.kind, "suggestion");
  assert.equal(ann.text.toString(), HEAD);
});

test("a removed page's session stores nothing once the write in flight finishes", async () => {
  const h = harness();
  const writes = h.persisted;
  const ann = await annConnected(h);
  ann.text.insert(0, "x");
  let release;
  const original = h.ports.commit;
  h.ports.commit = (principal, input) => new Promise((resolve) => { release = () => resolve(original(principal, input)); });
  const committing = h.session.commit();
  const ended = h.session.end(async () => ({ removed: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const before = writes.length;
  release();
  await committing;
  await ended;
  ann.text.insert(0, "y");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writes.length, before + 1, "only the in-flight commit's own write, nothing after the end");
});

test("a removal that fails leaves the session writing", async () => {
  const h = harness();
  const writes = h.persisted;
  const ann = await annConnected(h);
  await assert.rejects(h.session.end(async () => { throw new Error("page_has_children"); }), /page_has_children/u);
  ann.text.insert(0, "z");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(writes.length > 0);
});

// The page session object removes a page from an intent it can resume (review: codex:2).
function removalFixture({ exists = true, failCleanup = false, deny = false } = {}) {
  const h = harness();
  const data = new Map([["identity", {spaceId: "space", pageId: "page"}], ["state", {secret: "page body"}]]);
  let present = exists;
  let cleanupCalls = 0;
  const authors = [];
  const originalExists = PostgresPageRepository.prototype.exists;
  const originalRemove = PostgresPageRepository.prototype.remove;
  PostgresPageRepository.prototype.exists = async () => present;
  PostgresPageRepository.prototype.remove = async input => {
    authors.push(input.principal.id);
    if (deny) throw new PageControlError("page_edit_forbidden", 403);
    present = false;
    return {removed: true};
  };
  const object = Object.create(RelayPageSession.prototype);
  Object.assign(object, {session: h.session, tickets: new Map(), spaceId: null, pageId: null,
    env: {RELAY_POSTGRES_SHARD_ID: "test", RELAY_POSTGRES: {connectionString: "postgresql://localhost/unused"}},
    ctx: {getWebSockets: () => [], storage: {
      get: async key => data.get(key),
      put: async (...args) => {
        if (args.length === 2) data.set(...args);
        else for (const [key,value] of Object.entries(args[0])) data.set(key,value);
      },
      delete: async key => data.delete(key),
      setAlarm: async value => data.set("alarm", value),
      deleteAll: async () => {
        cleanupCalls++;
        if (failCleanup && cleanupCalls === 1) throw new Error("simulated cleanup failure");
        data.clear();
      }
    }}});
  cleanups.push(() => {PostgresPageRepository.prototype.exists = originalExists;
    PostgresPageRepository.prototype.remove = originalRemove;});
  return {object, h, data, authors, cleanupCalls: () => cleanupCalls,
    request: () => new Request("https://page-session/internal/remove", {method: "POST",
      body: JSON.stringify({spaceId: "space", pageId: "page", principal: human("ann")})})};
}

test("removal: DELETE retry completes cleanup after the PG row is gone", async () => {
  const f = removalFixture({failCleanup: true});
  assert.equal((await f.object.fetch(f.request())).status, 500);
  assert.ok(f.data.has("removing"));
  assert.equal((await f.object.fetch(f.request())).status, 200);
  assert.equal(f.cleanupCalls(), 2);
  assert.equal(f.data.size, 0);
  assert.deepEqual(f.authors, ["ann"]);
});

test("removal: alarm completes cleanup after a successful PG deletion", async () => {
  const f = removalFixture({exists: false});
  f.data.set("removing", {principal: human("ann")});
  await f.object.alarm();
  assert.equal(f.data.size, 0);
  assert.deepEqual(f.authors, []);
});

test("removal: alarm resumes pre-PG intent under the original author", async () => {
  const f = removalFixture();
  f.data.set("removing", {principal: human("ann")});
  await f.object.alarm();
  assert.equal(f.data.size, 0);
  assert.deepEqual(f.authors, ["ann"]);
});

test("removal: denied resumed deletion preserves stored content", async () => {
  const f = removalFixture({deny: true});
  f.data.set("removing", {principal: human("ann")});
  await f.object.alarm();
  assert.equal(f.data.has("state"), true);
  assert.equal(f.data.has("removing"), false);
  assert.equal(f.cleanupCalls(), 0);
  assert.deepEqual(f.authors, ["ann"]);
});

test("a session kept as markdown text before pages were documents keeps its pending edits", async () => {
  const legacy = new Y.Doc();
  legacy.getText("markdown").insert(0, `pending ${HEAD}`);
  const h = harness();
  await h.session.ensureLoaded(human("ann"), { base: { revision: 1, body: HEAD, agentSuggestOnly: false },
    update: Y.encodeStateAsUpdate(legacy), editors: [{ principal: human("ann"), seq: 1 }], editSeq: 1 });
  legacy.destroy();
  assert.equal(h.session.markdown(), `pending ${HEAD}`);
  assert.equal(h.session.doc.getText("markdown").length, 0, "the old text is emptied");
  await h.session.commit();
  assert.equal(h.commits[0].principal, "ann");
  assert.equal(h.commits[0].body, `pending ${HEAD}`);
});

test("pages written by hand and Agent edits in any markdown style merge as the same document", async () => {
  const h = harness({ head: "# Project\n* one\n* two\n" });
  await h.session.ensureLoaded(human("ann"));
  assert.equal(h.session.hasPendingEdits, false, "opening a page never rewrites it");
  const ann = h.connect("c-ann", human("ann"));
  ann.text.insert(ann.text.toString().indexOf("two") + 3, " and a half");
  await h.session.submitEdit(agent, { baseRevision: 1, body: "# Project\n* zero\n* one\n* two\n", conversationIds: [] });
  assert.equal(h.session.markdown(), "# Project\n\n- zero\n- one\n- two and a half\n");
});


const summarySessionModule = await compileCommonJsSourceModule(new URL("../src/page-session-do.ts", import.meta.url));
const summarySessionRequire = createRequire(new URL("../src/page-session-do.ts", import.meta.url));

function summaryGateFixture({ sockets, stored, beforeStart } = {}) {
  const data = new Map(stored ? [["summary", stored]] : []);
  const issued = [];
  const { RelayPageSession: SummarySession } = summarySessionModule(name => name === "./page-summary" ? {
    async startPageSummary(_env, input) {
      const requestId = `summary-${issued.length + 1}`;
      issued.push({ ...input, requestId });
      await beforeStart?.();
      return { started: true, requestId, revision: 3 };
    },
  } : name === "cloudflare:workers" ? { DurableObject } : summarySessionRequire(name));
  const socket = (kind) => ({ deserializeAttachment: () => ({ principal: { kind, id: kind, label: kind } }) });
  const connected = (sockets ?? []).map(socket);
  const object = Object.create(SummarySession.prototype);
  Object.assign(object, { spaceId: "space", pageId: "page", env: {},
    ctx: { getWebSockets: () => connected, storage: { get: async (key) => data.get(key),
      put: async (key, value) => { data.set(key, value); }, delete: async (key) => data.delete(key) } } });
  return { object, connected, data, issued };
}

test("summary: nothing starts while a person is in the editor; it starts when the last one leaves", async () => {
  const f = summaryGateFixture({ sockets: ["user", "user", "agent"] });
  await f.object.summaryDue();
  assert.equal(f.issued.length, 0, "two people are editing");
  await f.object.summaryDue(f.connected[0]);
  assert.equal(f.issued.length, 0, "one of them left, the other is still there");
  f.connected.splice(0, 1);
  await f.object.summaryDue(f.connected[0]);
  assert.equal(f.issued.length, 1, "the last person left; an Agent's connection does not hold it back");
  assert.equal(f.data.get("summary").requestId, f.issued[0].requestId, "the issued task is persisted for recovery");
});

test("summary: an Agent's edit starts one at once, and a second does not start beside one that is running", async () => {
  const idle = summaryGateFixture({ sockets: ["agent"] });
  await idle.object.summaryDue();
  assert.equal(idle.issued.length, 1);
  await idle.object.summaryDue();
  assert.equal(idle.issued.length, 1, "the persisted in-flight task prevents a second dispatch");
  const running = summaryGateFixture({ stored: { requestId: "r", revision: 3, startedAt: Date.now() } });
  await running.object.summaryDue();
  assert.equal(running.issued.length, 0, "one is being written");
  const ended = summaryGateFixture({ stored: { requestId: "r", revision: 3, startedAt: Date.now(), ended: true } });
  await ended.object.summaryDue();
  assert.equal(ended.issued.length, 1, "that one ended: a new task can be issued");
  assert.equal(ended.issued[0].triedRevision, 3, "the next dispatch remembers the revision already tried");
});

test("summary: overlapping edit and completion callbacks share the pending start", async () => {
  const f = summaryGateFixture();
  await Promise.all([f.object.summaryDue(), f.object.summaryDue(), f.object.summaryDue()]);
  assert.equal(f.issued.length, 1, "a task still preparing or retrying is already a pending summary");
  assert.equal(f.data.get("summary").requestId, f.issued[0].requestId);
});

test("summary: overlapping departures still start when the final person leaves", async () => {
  const f = summaryGateFixture({ sockets: ["user", "user"] });
  const first = f.object.summaryDue(f.connected[0]);
  f.connected.splice(0, 1);
  const last = f.object.summaryDue(f.connected[0]);
  await Promise.all([first, last]);
  assert.equal(f.issued.length, 1, "the earlier departure must not discard the final departure's check");
});

test("summary: a fast completion waits for its pending dispatch to be recorded", async () => {
  let release;
  const dispatch = new Promise(resolve => { release = resolve; });
  const f = summaryGateFixture({ beforeStart: () => dispatch });
  const starting = f.object.summaryDue();
  await new Promise(resolve => setImmediate(resolve));
  let ended = false;
  const ending = f.object.fetch(new Request("https://page-session/internal/summary-ended", { method: "POST",
    body: JSON.stringify({ spaceId: "space", pageId: "page", requestId: f.issued[0].requestId }) }))
    .then(response => { ended = true; return response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, false, "the result must not race ahead of its dispatch record");
  release();
  await starting;
  assert.equal((await ending).status, 200);
  await f.object.summaryStarting;
  assert.equal(f.issued[1].triedRevision, 3, "completion remembers the revision whose task just ended");
});

/**
 * An Agent's runtime co-writing the page (page-co-writer.ts): what the session asks it, and its
 * answers, streamed in as the harness writes them.
 */
function joinCoWriter(h, id = "w-agent", { canEdit = true, resumed = false, streams = false, acknowledged = false } = {}) {
  const asked = [];
  const send = h.ports.send;
  h.ports.send = (to, data) => {
    if (to !== id) return send(to, data);
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === PAGE_MESSAGE_NOTICE) return;
    assert.equal(type, PAGE_MESSAGE_CO_WRITE);
    asked.push(JSON.parse(decoding.readVarString(decoder)));
  };
  h.session.connect({ id, principal: agent, canEdit, coWriter: true, streams, acknowledged }, { resumed });
  const reply = (frame) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, PAGE_MESSAGE_CO_WRITE);
    encoding.writeVarString(encoder, JSON.stringify(frame));
    h.session.receive(id, encoding.toUint8Array(encoder));
  };
  const turns = () => asked.filter((frame) => frame.type === "turn");
  // Turns are named by the order they were asked in: the session numbers them from the clock.
  const turnId = (n) => turns()[n - 1]?.turn ?? n;
  return {
    asked,
    turns,
    turnId,
    write: (n, text) => reply({ type: "delta", turn: turnId(n), text }),
    /** A runtime keeping to the write rate: `at` is where `text` starts among what it sent for the turn. */
    writePaced: (n, text, at) => reply({ type: "delta", turn: turnId(n), text, paced: { at } }),
    donePaced: (n, at) => reply({ type: "done", turn: turnId(n), paced: { at } }),
    limited: () => asked.filter((frame) => frame.type === "limited"),
    done: (n) => reply({ type: "done", turn: turnId(n) }),
    /** A runtime streaming from a conversation opens turn `n` itself; `atOnce` for a message's write. */
    open: (n, atOnce = false) => reply({ type: "write", turn: n, ...(atOnce ? { atOnce } : {}) }),
    outcomes: () => asked.filter((frame) => frame.type === "outcome"),
  };
}

/** A person's caret, shared as their editor shares it, at the end of the first text holding `words`. */
function placeCaret(h, client, id, words) {
  const fragment = client.doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT);
  const { doc, mapping } = initProseMirrorDoc(fragment, pageSchema);
  let at = null;
  doc.descendants((node, pos) => {
    if (at === null && node.isText && node.text.includes(words)) at = pos + node.text.indexOf(words) + words.length;
  });
  const head = Y.relativePositionToJSON(absolutePositionToRelativePosition(at, fragment, mapping));
  client.awareness.setLocalState({ user: { name: id, color: "#123456" }, cursor: { anchor: head, head } });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PAGE_MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(client.awareness, [client.doc.clientID]));
  h.session.receive(`c-${id}`, encoding.toUint8Array(encoder));
}

const coWriterOf = (client) => [...client.awareness.getStates().values()].find((state) => state?.user?.kind === "agent");

test("an acknowledged co-writer yields its actual paragraph to a human and refuses the old socket output", async (t) => {
  const { h, ann, clock } = await outputSession(t);
  const writer = joinCoWriter(h, "native", { acknowledged: true });
  const request = writer.turns()[0];
  const turn = request.turn;
  const envelope = { stream: "bound-answer", session: request.outputSession, expiresAt: clock.now + 60_000 };
  let seq = 0;
  const send = (reply) => h.session.output(agent, { ...envelope, seq: seq++, reply });
  assert.equal((await send({ type: "answer", turn })).status, "accepted");
  let at = 0;
  for (const text of ['⟦after ', '"none"⟧', 'A draft']) {
    clock.now += 500;
    assert.equal((await send({ type: "delta", turn, text, paced: { at } })).status, "accepted");
    at += text.length;
  }
  writer.write(1, " socket bypass");
  assert.doesNotMatch(ann.text.toString(), /socket bypass/u);
  ann.text.insert(ann.text.toString().indexOf("A draft"), "Ann: ");
  assert.deepEqual(writer.asked.at(-1), { type: "interrupt", turn });
  const refused = await send({ type: "delta", turn, text: " too late", paced: { at } });
  assert.ok(refused.notices.some((notice) => notice.type === "interrupt"));
  assert.match(ann.text.toString(), /Ann: A draft/u);
  assert.doesNotMatch(ann.text.toString(), /too late/u);
});

test("live co-writing follows current edit access and suggestion policy, including late replies", async (t) => {
  for (const policy of ["access", "suggestions"]) await t.test(policy, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    const ann = await annConnected(h);
    const writer = joinCoWriter(h);
    const writable = (allowed) => policy === "access"
      ? h.session.setCanEdit("w-agent", allowed) : h.session.setAgentSuggestOnly(!allowed);
    writer.write(1, '⟦after "none"⟧\nAlready written');
    const before = ann.text.toString();
    writable(false);
    writer.write(1, '⟦after "none"⟧\nNot allowed');
    writer.done(1);
    assert.equal(ann.text.toString(), before, "accepted text stays; later text is refused");
    assert.deepEqual(writer.asked.at(-1), { type: "interrupt", turn: writer.turnId(1) });
    ann.text.insert(ann.text.length, "\nA person's edit\n");
    t.mock.timers.tick(CO_WRITER_PAUSE_MS);
    assert.equal(writer.turns().length, 1, "no new work while live writes are disallowed");
    writable(true);
    const next = writer.turns().at(-1);
    assert.equal(next.turn, writer.turnId(2), "restoring permission starts a fresh turn");
    assert.ok(next.turn > writer.turnId(1));
    assert.match(next.text, /A person's edit/u);
    writer.write(1, '⟦after "none"⟧\nA late reply');
    writer.write(2, '⟦after "none"⟧\nAllowed now');
    writer.done(2);
    assert.match(ann.text.toString(), /Allowed now/u);
    assert.doesNotMatch(ann.text.toString(), /Not allowed|A late reply/u);
    ann.text.insert(ann.text.length, "\nAnother edit\n");
    writable(false);
    t.mock.timers.tick(CO_WRITER_PAUSE_MS);
    assert.equal(writer.turns().length, 2, "withdrawing permission also cancels a pending pause timer");
  });
});

test("a page head reloaded as suggest-only also pauses a connected co-writer", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const writer = joinCoWriter(h);
  h.ports.loadHead = async () => ({ revision: 1, body: HEAD, agentSuggestOnly: true });
  await h.session.reload(human("ann"));
  writer.write(1, '⟦after "none"⟧\nNot allowed');
  writer.done(1);
  assert.equal(ann.text.toString(), HEAD);
  assert.deepEqual(writer.asked.at(-1), { type: "interrupt", turn: writer.turnId(1) });
});

test("new and resumed co-writers cannot write without current live write permission", async () => {
  for (const resumed of [false, true]) for (const policy of ["access", "suggestions"]) {
    const h = harness({ suggestOnly: policy === "suggestions" });
    const ann = await annConnected(h);
    const writer = joinCoWriter(h, "w-agent", { canEdit: policy !== "access", resumed });
    assert.equal(writer.turns().length, 0);
    writer.write(1, '⟦after "none"⟧\nNot allowed');
    writer.done(1);
    assert.equal(ann.text.toString(), HEAD);
  }
});

test("a co-writing Agent reads the page as it joins, and its words stream into the page under its caret", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const writer = joinCoWriter(h);
  assert.equal(writer.turns().length, 1);
  assert.match(writer.turns()[0].text, /The page now:\n<<<PAGE\n# Project\n/u);
  assert.equal(coWriterOf(ann).activity, "thinking", "it is on the page while it thinks");

  writer.write(1, "I'll fill the notes.\n⟦after \"none\"⟧\n- first ");
  assert.match(ann.text.toString(), /none\n\n- first\n$/u, "its words show as they come, its talk does not");
  assert.equal(coWriterOf(ann).activity, "writing");
  assert.ok(coWriterOf(ann).cursor, "its caret is where it writes");
  writer.write(1, "point\n- second point\n");
  writer.done(1);
  assert.equal(ann.text.toString(), HEAD.replace("none\n", "none\n\n- first point\n- second point\n"));
  assert.equal(coWriterOf(ann).activity, "watching");

  await h.session.commit();
  assert.equal(h.commits.at(-1).principal, agent.id, "its words are its own edit");
  assert.deepEqual(h.commits.at(-1).conversationIds, ["conv-1"], "from the conversation it co-writes from");
});

test("someone who keeps typing is heard every few seconds, not only when they stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { ann, writer } = await annAfterAPass();
  // A keystroke every second, never pausing for the 1.5 s the pause waits for.
  const at = HEAD.indexOf("In progress") + "In progress".length;
  for (let second = 0; second < CO_WRITER_KEEP_UP_MS / 1000; second++) {
    ann.text.insert(at + second, "x");
    t.mock.timers.tick(1000);
  }
  assert.equal(writer.turns().length, 2, "heard within the keep-up time while still typing");
  assert.match(writer.turns()[1].text, /In progressxxxx/u);
});

test("a co-writing Agent hears what changed when people pause, and stops when someone edits what it writes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ann, writer } = await annAfterAPass();

  // Typing elsewhere is not news until the person pauses.
  ann.text.insert(HEAD.indexOf("In progress") + "In progress".length, ", blocked on review");
  assert.equal(writer.turns().length, 1);
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  assert.equal(writer.turns().length, 2);
  assert.match(writer.turns()[1].text, /<<<SECTION\n## Status\n\nIn progress, blocked on review\nSECTION>>>/u,
    "only the section that changed");

  writer.write(2, "⟦after \"none\"⟧\nA paragraph the Agent ");
  assert.match(ann.text.toString(), /A paragraph the Agent\n$/u);
  // Ann edits the very paragraph it is writing: it stops there, and the rest of its answer is not written.
  const at = ann.text.toString().indexOf("A paragraph");
  ann.text.insert(at, "Ann: ");
  assert.deepEqual(writer.asked.at(-1), { type: "interrupt", turn: writer.turnId(2) });
  assert.equal(coWriterOf(ann).activity, "waiting");
  writer.write(2, "keeps writing after being stopped.");
  writer.done(2);
  assert.doesNotMatch(ann.text.toString(), /after being stopped/u);
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  assert.match(writer.turns()[2].text, /You were stopped: someone edited what you were writing\./u);
});

test("a co-writing Agent whose answer goes quiet is asked afresh, instead of the page waiting on it for good", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ann, writer } = await annCoWriting();
  writer.write(1, "⟦after \"none\"⟧\n- a first");
  // Its harness's turn was cancelled from the conversation and never said it ended.
  ann.text.insert(HEAD.indexOf("In progress") + "In progress".length, ", blocked");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  assert.equal(writer.turns().length, 1, "the open turn is waited on");
  t.mock.timers.tick(CO_WRITER_TURN_MS);
  assert.deepEqual(writer.asked.at(-2), { type: "interrupt", turn: writer.turnId(1) });
  assert.equal(writer.turns().length, 2, "what changed meanwhile is asked about at once");
  assert.match(writer.turns()[1].text, /Your last answer went quiet and was given up\./u);
  // The people on the page see it went quiet, and since when it is doing what it does now.
  assert.equal(coWriterOf(ann).stalled, true);
  assert.equal(typeof coWriterOf(ann).since, "number");
  writer.write(2, "⟦after \"a first\"⟧\n- a second\n");
  assert.equal(coWriterOf(ann).stalled, undefined, "writing again clears it");
  writer.done(2);
  assert.match(ann.text.toString(), /a second/u, "and it writes again");
});

/** Ann on the page, and an Agent that has just joined to co-write it. */
async function annCoWriting() {
  const h = harness();
  const ann = await annConnected(h);
  return { h, ann, writer: joinCoWriter(h) };
}

/** Ann on the page, with a co-writer that has read it and passed on its first turn. */
async function annAfterAPass() {
  const joined = await annCoWriting();
  joined.writer.write(1, "⟦pass⟧");
  joined.writer.done(1);
  return joined;
}

// Revision saves and awareness were the only historical signals; neither times actual text delivery.
test("co-writing observations time CRDT text changes, excluding markers and pass, without waiting for a revision", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  const events = [];
  h.ports.observeCoWriting = (principal, event) => {
    assert.equal(principal.id, agent.id);
    events.push(event);
  };
  const ann = await annConnected(h);
  const writer = joinCoWriter(h);
  writer.write(1, "⟦pass⟧");
  writer.done(1);
  assert.equal(events.length, 1);
  assert.equal(events[0].firstTextMs, null);
  assert.equal(events[0].editToTurnMs, null, "joining is not a human edit");
  events.length = 0;
  ann.text.insert(HEAD.indexOf("In progress"), "Still ");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  t.mock.timers.tick(300);
  writer.write(2, '⟦after "none"⟧');
  assert.equal(events.length, 0, "the marker and blank paragraph are not text");
  t.mock.timers.tick(200);
  writer.write(2, "Hello");
  assert.match(ann.text.toString(), /Hello/u, "the client received text before the observation");
  assert.equal(h.commits.length, 0, "no revision has been saved");
  assert.deepEqual(events[0], { event: "first_text", outcome: "writing", turn: writer.turnId(2),
    durationMs: 500, editToTurnMs: CO_WRITER_PAUSE_MS, firstDeltaMs: 300, firstTextMs: 500,
    editToFirstTextMs: CO_WRITER_PAUSE_MS + 500, maxWriteGapMs: null, writes: 1 });
  t.mock.timers.tick(700);
  writer.write(2, " world ");
  writer.done(2);
  writer.done(2);
  assert.equal(events.length, 2, "one first-text and one terminal observation, including late duplicate replies");
  assert.deepEqual(events[1], { ...events[0], event: "turn_end", outcome: "done", durationMs: 1200,
    maxWriteGapMs: 700, writes: 2 });
  // A failed sink must not change whether the person's next edit is heard or the Agent writes.
  h.ports.observeCoWriting = () => { throw new Error("sink unavailable"); };
  ann.text.insert(HEAD.indexOf("In progress"), "Again ");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  writer.write(3, '⟦after "none"⟧More text');
  writer.done(3);
  assert.match(ann.text.toString(), /More text/u);
});

async function observedCoWriter(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const joined = await annAfterAPass();
  const events = [];
  joined.h.ports.observeCoWriting = (_principal, event) => events.push(event);
  return { ...joined, events };
}

async function afterFirstHumanEdit(t) {
  const joined = await observedCoWriter(t);
  const at = HEAD.indexOf("In progress");
  joined.ann.text.insert(at, "First ");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  return { ...joined, at };
}

test("co-writing timings include queued human edits without attributing an earlier answer to them", async (t) => {
  const { ann, writer, events, at } = await afterFirstHumanEdit(t);
  writer.write(2, '⟦after "none"⟧Already writing');
  t.mock.timers.tick(500);
  ann.text.insert(at, "Second ");
  t.mock.timers.tick(5000);
  assert.equal(writer.turns().length, 2, "the previous turn is still answering");
  writer.done(2);
  assert.equal(events.length, 2);
  assert.equal(events[0].editToFirstTextMs, CO_WRITER_PAUSE_MS, "the existing text precedes the second edit");
  assert.equal(writer.turns().length, 3);
  t.mock.timers.tick(200);
  writer.write(3, '⟦after "none"⟧The next answer');
  assert.equal(events[2].editToTurnMs, 5000);
  assert.equal(events[2].firstTextMs, 200);
  assert.equal(events[2].editToFirstTextMs, 5200);
  writer.done(3);
});

test("new human input refreshes an unwritten answer once, with full current instructions, and retires late replies", async (t) => {
  const { ann, writer, events, at } = await afterFirstHumanEdit(t);
  t.mock.timers.tick(500);
  ann.text.insert(at, "Second ");
  t.mock.timers.tick(CO_WRITER_KEEP_UP_MS - 501);
  assert.equal(writer.turns().length, 2, "a young answer has time to start writing");
  t.mock.timers.tick(1);
  assert.equal(writer.turns().length, 3, "new input does not wait for the unwritten answer to finish");
  assert.ok(writer.asked.some((frame) => frame.type === "interrupt" && frame.turn === writer.turnId(2)));
  assert.match(writer.turns()[2].text, /Second First In progress/u);
  assert.match(writer.turns()[2].text, /Only what you write inside these markers reaches the page/u,
    "the retired request may never have reached the harness, so instructions must travel again");
  assert.equal(events[0].outcome, "interrupted");
  assert.equal(events[0].durationMs, CO_WRITER_KEEP_UP_MS);
  writer.write(2, '⟦after "none"⟧An obsolete answer');
  writer.done(2);
  assert.doesNotMatch(ann.text.toString(), /obsolete/u);
  ann.text.insert(at, "Third ");
  t.mock.timers.tick(CO_WRITER_KEEP_UP_MS + 1000);
  assert.equal(writer.turns().length, 3, "the replacement gets to finish even while people continue typing");
  writer.write(3, '⟦after "none"⟧The current answer');
  writer.done(3);
  assert.match(ann.text.toString(), /current answer/u);
});

test("an initial unwritten page answer can be refreshed without losing its startup instructions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { ann, writer } = await annCoWriting();
  ann.text.insert(HEAD.indexOf("In progress"), "First edit ");
  t.mock.timers.tick(CO_WRITER_KEEP_UP_MS);
  assert.equal(writer.turns().length, 2);
  assert.match(writer.turns()[1].text, /First edit In progress/u);
  assert.match(writer.turns()[1].text, /Only what you write inside these markers reaches the page/u);
});

test("an empty replacement deletes old words without reporting newly written text", async (t) => {
  const { ann, writer, events } = await observedCoWriter(t);
  ann.text.insert(HEAD.indexOf("In progress"), "Still ");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  writer.write(2, '⟦replace "none"⟧');
  writer.done(2);
  assert.doesNotMatch(ann.text.toString(), /none/u);
  assert.equal(events.length, 1, "only a terminal observation, no first-text event for deletion");
  assert.equal(events[0].firstTextMs, null);
  assert.equal(events[0].writes, 0);
});

test("another Agent's document update is not measured as a human edit", async (t) => {
  const { h, writer, events } = await observedCoWriter(t);
  const other = h.connect("c-other", { ...agent, id: "other-agent" });
  other.text.insert(HEAD.indexOf("In progress"), "Also ");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  writer.write(2, '⟦after "none"⟧A response to another Agent');
  writer.done(2);
  assert.equal(events.length, 2);
  assert.equal(events[0].editToTurnMs, null);
  assert.equal(events[0].editToFirstTextMs, null);
  other.text.insert(HEAD.indexOf("In progress"), "Next ");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  t.mock.timers.tick(500);
  other.text.insert(HEAD.indexOf("In progress"), "More ");
  t.mock.timers.tick(CO_WRITER_KEEP_UP_MS + 1000);
  assert.equal(writer.turns().length, 3, "another Agent's changes do not refresh the open answer");
  writer.done(3);
});

test("a quiet co-writing turn reports stalled once with missing text timings, and ignores its late output", async (t) => {
  const { ann, writer, events } = await observedCoWriter(t);
  ann.text.insert(HEAD.indexOf("In progress"), "Still ");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  t.mock.timers.tick(CO_WRITER_TURN_MS);
  assert.deepEqual(events, [{ event: "turn_end", outcome: "stalled", turn: writer.turnId(2),
    durationMs: CO_WRITER_TURN_MS, editToTurnMs: CO_WRITER_PAUSE_MS, firstDeltaMs: null,
    firstTextMs: null, editToFirstTextMs: null, maxWriteGapMs: null, writes: 0 }]);
  const before = ann.text.toString();
  writer.write(2, '⟦after "none"⟧Too late');
  writer.done(2);
  assert.equal(ann.text.toString(), before);
  assert.equal(events.length, 1);
});

test("a person takes back what a co-writing Agent last wrote, and the Agent hears so", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { h, ann, writer } = await annCoWriting();
  assert.equal(h.session.undoCoWriting("conv-1", "Ann"), "nothing", "it has written nothing yet");
  writer.write(1, "⟦after \"none\"⟧\n- first point\n");
  writer.done(1);
  assert.match(ann.text.toString(), /- first point/u);
  assert.equal(coWriterOf(ann).undo, true, "its change can be taken back");
  assert.equal(h.session.undoCoWriting("conv-other", "Ann"), "nothing", "another conversation's Agent is not this one");
  assert.equal(h.session.undoCoWriting("conv-1", "Ann"), "undone");
  assert.equal(ann.text.toString(), HEAD);
  assert.equal(coWriterOf(ann).undo, undefined, "only its last change could be taken back");
  ann.text.insert(ann.text.length, "\nmore\n");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  assert.match(writer.turns().at(-1).text, /Ann took back your last change/u);
});

test("what a co-writing Agent is writing is taken back too", async () => {
  const { h, ann, writer } = await annCoWriting();
  writer.write(1, "⟦after \"none\"⟧\n- half a point");
  assert.equal(h.session.undoCoWriting("conv-1", "Ann"), "undone");
  assert.deepEqual(writer.asked.at(-1), { type: "interrupt", turn: writer.turnId(1) }, "it stops writing");
  assert.equal(ann.text.toString(), HEAD);
  writer.done(1);
});

test("a co-writing Agent's change that someone edited since is not taken back", async () => {
  const { h, ann, writer } = await annCoWriting();
  writer.write(1, "⟦after \"none\"⟧\n- first point\n");
  writer.done(1);
  ann.text.insert(ann.text.toString().indexOf("first point"), "really ");
  assert.equal(h.session.undoCoWriting("conv-1", "Ann"), "changed");
  assert.match(ann.text.toString(), /- really first point/u);
  assert.equal(coWriterOf(ann).undo, undefined);
});

test("a co-writing Agent keeps out of the paragraph someone is typing in, and hears what it quoted wrong", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const ann = await annConnected(h);
  placeCaret(h, ann, "ann", "In progress");
  const writer = joinCoWriter(h);
  assert.match(writer.turns()[0].text, /Typing now: ann in "In progress"\./u);
  writer.write(1, "⟦replace \"In progress\"⟧Done⟦end⟧⟦after \"no such words\"⟧text⟦note \"In progress\"⟧Blocked on what?");
  writer.done(1);
  assert.equal(ann.text.toString(), HEAD, "nothing was written");
  assert.equal(coWriterOf(ann).say, "Blocked on what?", "what it says to people shows beside its caret");
  ann.text.insert(ann.text.length, "\nmore\n");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS);
  const told = writer.turns()[1].text;
  assert.match(told, /ann is typing in the paragraph holding "In progress"; it was left alone\./u);
  assert.match(told, /Your ⟦after⟧ quoted "no such words", which is not on the page/u);
});

test("an Agent writing from its conversation streams into the page in turns it opens itself, and is asked nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const ann = await annConnected(h);
  const writer = joinCoWriter(h, "w-agent", { streams: true });
  assert.equal(writer.asked.length, 0, "joining asks it nothing");
  assert.equal(coWriterOf(ann).activity, "watching", "it is on the page");

  writer.open(1);
  assert.equal(coWriterOf(ann).activity, "thinking");
  writer.write(1, "⟦after \"none\"⟧\n- first ");
  assert.match(ann.text.toString(), /none\n\n- first\n$/u, "its words show as they come");
  assert.equal(coWriterOf(ann).activity, "writing");
  writer.write(1, "point\n- second point\n");
  writer.done(1);
  assert.equal(ann.text.toString(), HEAD.replace("none\n", "none\n\n- first point\n- second point\n"));
  assert.deepEqual(writer.outcomes(), [{ type: "outcome", turn: 1, problems: [] }], "all of it reached the page");
  assert.equal(coWriterOf(ann).undo, true, "a person can take it back");
  await h.session.commit();
  assert.equal(h.commits.at(-1).principal, agent.id, "its words are its own edit");
  assert.deepEqual(h.commits.at(-1).conversationIds, ["conv-1"], "from the conversation it writes from");

  // People typing and pausing is no question for it.
  ann.text.insert(HEAD.indexOf("In progress") + "In progress".length, ", blocked");
  t.mock.timers.tick(CO_WRITER_PAUSE_MS * 2);
  assert.equal(writer.turns().length, 0);
});

/** Ann on the page, and an Agent writing into it from its conversation, in the turn it has just opened. */
async function annWithStreamingWriter(ports = {}) {
  const h = harness();
  Object.assign(h.ports, ports);
  const ann = await annConnected(h);
  const writer = joinCoWriter(h, "w-agent", { streams: true });
  writer.open(1);
  return { h, ann, writer };
}

test("a streamed Agent edit survives a restart before its first commit with its own authorship", async () => {
  const { h, writer } = await annWithStreamingWriter();
  writer.write(1, '⟦after "none"⟧\nA durable first word.');
  writer.done(1);
  const written = h.session.markdown();
  assert.match(written, /A durable first word\./u);
  assert.equal(h.commits.length, 0);

  const resumed = new PageSession(h.ports);
  cleanups.push(() => resumed.destroy());
  await resumed.ensureLoaded(human("ann"), h.persisted.at(-1));
  assert.equal(resumed.markdown(), written, "visible Agent words are pending edits, not abandoned presentation");
  await resumed.commit();
  assert.equal(h.commits.at(-1).principal, agent.id);
  assert.deepEqual(h.commits.at(-1).conversationIds, ["conv-1"]);
});

test("an Agent writing from its conversation hears what did not reach the page, and why", async () => {
  const { ann, writer } = await annWithStreamingWriter();
  writer.write(1, "⟦after \"no such words\"⟧\nlost⟦end⟧⟦after \"In progress\"⟧\nNext: review\n");
  writer.done(1);
  assert.match(ann.text.toString(), /In progress\n\nNext: review\n/u, "what it quoted right is written");
  assert.deepEqual(writer.outcomes().at(-1), { type: "outcome", turn: 1,
    problems: ["Your ⟦after⟧ quoted \"no such words\", which is not on the page; nothing was written there."] });

  writer.open(2);
  writer.write(2, "⟦after \"none\"⟧\nA paragraph the Agent ");
  ann.text.insert(ann.text.toString().indexOf("A paragraph"), "Ann: ");
  assert.deepEqual(writer.asked.at(-2), { type: "interrupt", turn: 2 }, "it stops where someone edits");
  assert.deepEqual(writer.asked.at(-1), { type: "outcome", turn: 2,
    problems: ["You were stopped: someone edited what you were writing."] });
  writer.write(2, "keeps writing after being stopped.");
  writer.done(2);
  assert.doesNotMatch(ann.text.toString(), /after being stopped/u);
  assert.equal(writer.outcomes().length, 2, "a turn has one outcome");
});

test("only a co-writer that streams opens turns, one at a time, and only while it may write", async () => {
  const h = harness();
  await annConnected(h);
  const asked = joinCoWriter(h, "w-asked");
  asked.open(99);
  assert.deepEqual(asked.asked.at(-1), { type: "interrupt", turn: 99 }, "a co-writer the session asks opens none");
  const writer = joinCoWriter(h, "w-agent", { streams: true });
  writer.open(1);
  writer.open(2);
  assert.deepEqual(writer.asked.at(-2), { type: "interrupt", turn: 2 }, "a second turn while one is open is refused");
  writer.done(1);
  const suggesting = harness({ suggestOnly: true });
  await annConnected(suggesting);
  const refused = joinCoWriter(suggesting, "w-agent", { streams: true });
  refused.open(1);
  assert.deepEqual(refused.asked.map((frame) => frame.type), ["interrupt", "outcome"], "a page that takes suggestions only refuses it");
  assert.match(refused.outcomes()[0].problems[0], /does not take your words live now/u, "and says why");
});

test("a co-writer's words reach the page at most every so often while they stream, and all of them at the end", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { ann, writer } = await annWithStreamingWriter();
  writer.write(1, "⟦after \"none\"⟧\nOne");
  assert.match(ann.text.toString(), /\nOne\n$/u);
  t.mock.timers.tick(10);
  writer.write(1, " two");
  writer.write(1, " three");
  assert.match(ann.text.toString(), /\nOne\n$/u, "words that come right after wait a moment");
  t.mock.timers.tick(CO_WRITER_WRITE_EVERY_MS);
  assert.match(ann.text.toString(), /\nOne two three\n$/u, "then go in together");
  t.mock.timers.tick(10);
  writer.write(1, " four");
  writer.done(1);
  assert.match(ann.text.toString(), /\nOne two three four\n$/u, "the end writes what is left at once");
});

test("what a co-writing Agent wrote is named with its presence, and stays marked after it leaves", async () => {
  const { h, ann, writer } = await annWithStreamingWriter();
  writer.write(1, "⟦after \"none\"⟧\nA line the Agent wrote\n");
  writer.done(1);
  const written = (state) => (state.wrote ?? []).map((change) => {
    const from = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(change.from), ann.doc);
    return from?.type.toString();
  });
  assert.deepEqual(written(coWriterOf(ann)), ["A line the Agent wrote"], "its presence names the paragraph it wrote");
  assert.equal(coWriterOf(ann).undo, true);
  h.session.disconnect("w-agent");
  const left = coWriterOf(ann);
  assert.equal(left?.activity, "watching", "its caret rests at its change");
  assert.deepEqual(written(left), ["A line the Agent wrote"], "and what it wrote stays marked");
  assert.equal(left.undo, undefined, "nothing can be taken back from a writer that has left");
});

/** What stands after "none" on Ann's page: where the Agents write in these tests. */
const afterNone = (ann) => ann.text.toString().split("none\n")[1].trim();

// What a reader sees of an Agent's streamed words is what it has sent (pages-live-document.md §4.2): nothing
// is held back to be shown at a reading pace later.
test("while a person reads the page, an Agent's words reach it as they come, and its turn ends with them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { ann, writer } = await annWithStreamingWriter();
  writer.write(1, "⟦after \"none\"⟧\nOne two. Three");
  assert.equal(afterNone(ann), "One two. Three", "all it has sent, at once");
  assert.equal(coWriterOf(ann).activity, "writing");
  t.mock.timers.tick(1000);
  writer.write(1, " four.");
  t.mock.timers.tick(80);
  assert.equal(afterNone(ann), "One two. Three four.");
  assert.equal(writer.outcomes().length, 0, "its turn is not over while it still sends");
  writer.done(1);
  assert.deepEqual(writer.outcomes(), [{ type: "outcome", turn: 1, problems: [] }], "it ends as soon as it is sent");
  assert.equal(coWriterOf(ann).activity, "watching");
});

test("with nobody reading the page, or for a message's write, an Agent's words land as they come", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const unread = harness();
  await unread.session.ensureLoaded(agent);
  const alone = joinCoWriter(unread, "w-agent", { streams: true });
  alone.open(1);
  alone.write(1, "⟦after \"none\"⟧\nNobody waits on this. It lands whole.");
  alone.done(1);
  assert.match(unread.session.markdown(), /none\n\nNobody waits on this\. It lands whole\.\n$/u);
  assert.deepEqual(alone.outcomes(), [{ type: "outcome", turn: 1, problems: [] }]);

  const h = harness();
  const ann = await annConnected(h);
  const sending = joinCoWriter(h, "w-agent", { streams: true });
  sending.open(1, true);
  sending.write(1, "⟦after \"none\"⟧\nA message's write. Its sender waits on it.");
  sending.done(1);
  assert.equal(afterNone(ann), "A message's write. Its sender waits on it.");
  assert.deepEqual(sending.outcomes(), [{ type: "outcome", turn: 1, problems: [] }]);
});

test("an Agent's consecutive writes each reach the page with their own outcome", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { ann, writer } = await annWithStreamingWriter();
  writer.write(1, "⟦after \"none\"⟧\nFirst words here.");
  writer.done(1);
  writer.open(2);
  writer.write(2, "⟦after \"In progress\"⟧\nSecond words follow.");
  writer.done(2);
  assert.equal(writer.asked.filter((frame) => frame.type === "interrupt").length, 0, "neither is refused");
  assert.equal(afterNone(ann), "First words here.");
  assert.match(ann.text.toString(), /In progress\n\nSecond words follow\.\n/u);
  assert.deepEqual(writer.outcomes().map((frame) => [frame.turn, frame.problems]), [[1, []], [2, []]]);
});

test("taking back what an Agent is still writing leaves the page as it was, and its next write goes on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { h, ann, writer } = await annWithStreamingWriter();
  writer.write(1, "⟦after \"none\"⟧\nA paragraph Ann does not want.");
  assert.equal(afterNone(ann), "A paragraph Ann does not want.");
  assert.equal(h.session.undoCoWriting("conv-1", "Ann"), "undone");
  assert.deepEqual(writer.outcomes()[0], { type: "outcome", turn: 1,
    problems: ["You were stopped: Ann took back what you were writing."] });
  assert.equal(ann.text.toString(), HEAD, "the page is as it was");
  writer.open(2);
  writer.write(2, "⟦after \"In progress\"⟧\nNext.");
  writer.done(2);
  assert.equal(ann.text.toString(), HEAD.replace("In progress\n", "In progress\n\nNext.\n"), "only its next write stands");
  assert.deepEqual(writer.outcomes().at(-1), { type: "outcome", turn: 2, problems: [] });
});

// The session takes an Agent's live words at a rate (PAGE_CO_WRITE_RATE), as an API limits its callers: a
// write past the allowance is refused whole and the runtime told when to go on, so nothing is held to be
// shown later and the page is always exactly what the Agent was allowed to send.
test("a paced write past the Agent's allowance is refused whole, and the runtime hears where and when to go on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { ann, writer } = await annWithStreamingWriter();
  const marker = "⟦after \"none\"⟧\n";
  assert.equal([...marker].length, 15);
  writer.writePaced(1, marker, 0);
  t.mock.timers.tick(500);
  writer.writePaced(1, "One two th", 15);
  assert.equal(afterNone(ann), "One two th", "within the allowance: on the page as it is sent");
  writer.writePaced(1, "ree four f", 25);
  assert.equal(afterNone(ann), "One two th", "past it: nothing of it is taken");
  assert.deepEqual(writer.limited(), [{ type: "limited", turn: 1, at: 25, retryAfterMs: 250 }]);
  writer.writePaced(1, "ive", 35);
  assert.equal(writer.limited().at(-1).at, 25, "a write that does not follow on is refused too");
  t.mock.timers.tick(250);
  writer.donePaced(1, 35);
  assert.deepEqual(writer.outcomes(), [], "its end waits on every character it sent");
  assert.deepEqual(writer.limited().at(-1), { type: "limited", turn: 1, at: 25, retryAfterMs: 0 });
  writer.writePaced(1, "ree four f", 25);
  writer.donePaced(1, 35);
  assert.equal(afterNone(ann), "One two three four f");
  assert.deepEqual(writer.outcomes(), [{ type: "outcome", turn: 1, problems: [] }]);
});

test("a runtime that keeps to the rate is never refused, and an unpaced one is taken as before", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { ann, writer } = await annWithStreamingWriter();
  const text = "⟦after \"none\"⟧\nWords sent ten at a time, every half second, as the runtime paces them.";
  const chars = [...text];
  for (let at = 0; at < chars.length; at += 10) {
    writer.writePaced(1, chars.slice(at, at + 10).join(""), at);
    t.mock.timers.tick(500);
  }
  writer.done(1);
  assert.deepEqual(writer.limited(), []);
  assert.equal(afterNone(ann), "Words sent ten at a time, every half second, as the runtime paces them.");
  writer.open(2);
  writer.write(2, "⟦after \"In progress\"⟧\nAn older runtime sends what it has, and it is taken.");
  writer.done(2);
  assert.deepEqual(writer.limited(), []);
  assert.match(ann.text.toString(), /An older runtime sends what it has, and it is taken\./u);
});

test("an Agent's committed edit reaches someone reading the page whole, as soon as it is committed", async () => {
  const h = harness();
  const ann = await annConnected(h);
  const body = HEAD.replace("In progress", "Shipped today. Next week");
  const result = await h.session.submitEdit(agent, { baseRevision: 1, body, conversationIds: ["conv-1"] });
  assert.equal(result.revision, 2);
  assert.equal(ann.text.toString(), body, "the reader holds the committed page");
  assert.equal(coWriterOf(ann).activity, "editing", "it is done writing");
});

// Co-writing lasts while the people are on the page (pages-live-document.md §4.2): once they have been gone a
// while, each Agent co-writing it live is told to leave, and its Run rests and sleeps as any other.
function coWritingFixture({ sockets = [], peopleLeft, ended = [{ conversationId: "conv", startedByUserId: "ann" }] } = {}) {
  const data = new Map(peopleLeft ? [["peopleLeft", peopleLeft]] : []);
  const told = [];
  const endCalls = [];
  const db = summarySessionRequire("@xmatrix/db");
  const { RelayPageSession: Session, PAGE_CO_WRITING_PEOPLE_GONE_MS: goneMs } = summarySessionModule(name =>
    name === "./page-co-write-instruction" ? { async tellPageCoWriter(_env, input) { told.push(input); } }
    : name === "./page-summary" ? { async startPageSummary() { return { started: false }; } }
    : name === "@xmatrix/db" ? { ...db, PostgresPageRepository: class {
      async endCoWritingOnPage(input) { endCalls.push(input); return ended; } } }
    : name === "./postgres-authority-fleet" ? { createPostgresAuthorityDatabase: () => ({}) }
    : name === "cloudflare:workers" ? { DurableObject } : summarySessionRequire(name));
  const connected = sockets.map((attachment) => ({ deserializeAttachment: () => ({ spaceId: "space", pageId: "page",
    connectionId: attachment.principal.id, ...attachment }) }));
  let alarm = null;
  const object = Object.create(Session.prototype);
  Object.assign(object, { spaceId: "space", pageId: "page", env: {}, rehydrated: Promise.resolve(),
    summaryStarting: null,
    session: { disconnect() {}, hasPendingEdits: false, async commit() {} },
    ctx: { getWebSockets: () => connected, waitUntil: () => {}, storage: { get: async (key) => data.get(key),
      put: async (key, value) => { data.set(key, value); }, delete: async (key) => data.delete(key),
      getAlarm: async () => alarm, setAlarm: async (at) => { alarm = at; }, deleteAlarm: async () => { alarm = null; } } } });
  return { object, connected, data, told, endCalls, goneMs, alarm: () => alarm };
}

const person = { principal: { kind: "user", id: "ann", label: "Ann" } };
const coWriter = { principal: { kind: "user", id: "ann", label: "Ann" }, coWriter: true };

test("co-writing: the last person leaving starts the wait; an Agent's co-writer does not hold the page", async () => {
  const f = coWritingFixture({ sockets: [person, coWriter] });
  const leaving = f.connected[0];
  f.connected.splice(0, 1);
  await f.object.webSocketClose(leaving);
  assert.equal(f.data.get("peopleLeft").pageId, "page");
  assert.ok(f.alarm() !== null && f.alarm() <= Date.now() + f.goneMs, "the alarm comes when the wait is over");
  assert.equal(f.endCalls.length, 0, "a reload or a dropped connection gets time to come back");
});

test("co-writing: the people gone long enough, it ends and each Agent is told to leave", async () => {
  const f = coWritingFixture({ sockets: [coWriter],
    peopleLeft: { at: Date.now() - 3 * 60_000, spaceId: "space", pageId: "page" } });
  await f.object.coWritingDue();
  assert.deepEqual(f.endCalls.map(({ spaceId, pageId }) => [spaceId, pageId]), [["space", "page"]]);
  assert.deepEqual(f.told.map(({ conversationId, userId, active }) => [conversationId, userId, active]),
    [["conv", "ann", false]], "told under the authority of who started it");
  assert.equal(f.data.has("peopleLeft"), false);
});

test("co-writing: a person back in time, or a wait not yet over, keeps it", async () => {
  const back = coWritingFixture({ sockets: [person, coWriter],
    peopleLeft: { at: Date.now() - 3 * 60_000, spaceId: "space", pageId: "page" } });
  await back.object.coWritingDue();
  assert.equal(back.endCalls.length, 0);
  assert.equal(back.data.has("peopleLeft"), false, "they are back: nothing waits to end");
  const waiting = coWritingFixture({ sockets: [], peopleLeft: { at: Date.now(), spaceId: "space", pageId: "page" } });
  await waiting.object.coWritingDue();
  assert.equal(waiting.endCalls.length, 0);
  assert.ok(waiting.alarm() !== null, "the alarm is set for the rest of the wait");
  await waiting.object.settle();
  assert.ok(waiting.alarm() !== null, "an empty page keeps the alarm while co-writing waits to end");
});
