import assert from "node:assert/strict";
import test from "node:test";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  PAGE_DOCUMENT_FRAGMENT, PAGE_MESSAGE_AWARENESS, PAGE_MESSAGE_NOTICE, PAGE_MESSAGE_SYNC, PageSession,
  PageSessionConflict, pageFragmentMarkdown, setPageFragmentMarkdown,
} from "../src/page-session.ts";
import { RelayPageSession } from "../src/page-session-do.ts";
import { PageControlError, PostgresPageRepository } from "@xmatrix/db";

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
      return { revision, kind, headRevision };
    }),
    persist: async (state) => { persisted.push(state); },
    send: (id, data) => clients.get(id)?.deliver(data),
    broadcast: (data, except) => { for (const [id, client] of clients) if (id !== except) client.deliver(data); },
    sleep: async () => {},
  };
  const session = new PageSession(ports);
  cleanups.push(() => session.destroy());
  function connect(id, principal, canEdit = true) {
    const doc = new Y.Doc();
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

