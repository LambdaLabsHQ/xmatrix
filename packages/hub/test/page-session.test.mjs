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
import { CO_WRITER_PAUSE_MS, CO_WRITER_TURN_MS, CO_WRITER_WRITE_EVERY_MS } from "../src/page-co-writer.ts";
import { PAGE_MESSAGE_CO_WRITE } from "@xmatrix/protocol";
import { canonicalPageMarkdown as canonical, markdownToPageDoc, pageDocToMarkdown, pageSchema } from "@xmatrix/protocol/page-document";
import { absolutePositionToRelativePosition, initProseMirrorDoc, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
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

test("readers watch an Agent's edit written in a few words at a time, and people's typing meanwhile is kept", async () => {
  const h = harness();
  h.ports.writePaceMs = 1;
  const ann = await annConnected(h);
  const seen = [];
  ann.doc.on("update", () => seen.push(ann.text.toString()));
  const agentBody = HEAD.replace("In progress", "Shipped to every Space on Friday, behind one switch, with docs and a video");
  const editing = h.session.submitEdit(agent, { baseRevision: 1, body: agentBody, conversationIds: ["conv-1"] });
  await new Promise((resolve) => setTimeout(resolve, 3));
  ann.text.insert(ann.text.toString().indexOf("none"), "human note, ");
  await editing;
  const partial = seen.filter((text) => /Shipped/u.test(text) && !/a video/u.test(text));
  assert.ok(partial.length >= 2, "the text arrives in several steps, not at once");
  assert.match(ann.text.toString(), /with docs and a video/u);
  assert.match(ann.text.toString(), /human note, none/u, "what a person typed while it wrote stays");
  const agentState = [...ann.awareness.getStates().values()].find((state) => state?.user?.kind === "agent");
  assert.equal(agentState.activity, "editing", "it is done writing");
});

// Text-only streaming coverage cannot catch document normalization changing the merge
// baseline, or a restart treating a partially presented committed edit as pending human text.
test("paced structural edits converge to their committed document and keep concurrent typing", async () => {
  for (const replacement of [
    "| Name | Status |\n| --- | --- |\n| Web | shipped today |",
    "- first item\n- second item with more words",
    "```ts\nconst shipped = true;\n```",
  ]) {
    const h = harness();
    h.ports.writePaceMs = 1;
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

test("a restart finishes the committed paced edit and keeps typing persisted during it", async () => {
  const h = harness();
  h.ports.writePaceMs = 1;
  const ann = await annConnected(h);
  const body = HEAD.replace("In progress", "Shipped to every Space with docs and a video");
  const started = new Promise((resolve) => ann.doc.once("update", resolve));
  const editing = h.session.submitEdit(agent, { baseRevision: 1, body, conversationIds: ["conv-1"] });
  await started;
  ann.text.insert(ann.text.toString().indexOf("none"), "human note, ");
  const interrupted = h.persisted.at(-1);
  await editing;
  const resumed = new PageSession(h.ports);
  cleanups.push(() => resumed.destroy());
  await resumed.ensureLoaded(human("ann"), interrupted);
  assert.equal(resumed.markdown(), body.replace("none", "human note, none"));
  assert.equal(h.commits.length, 1, "recovering presentation does not repeat the Agent's commit");
  await resumed.commit();
  assert.equal(h.commits.at(-1).principal, "ann");
  assert.equal(h.commits.at(-1).body, resumed.markdown());
});

test("two Agents write the page at the same time, and a person's commit meanwhile keeps what they are still writing", async () => {
  const h = harness();
  h.ports.writePaceMs = 2;
  const ann = await annConnected(h);
  const codex = { ...agent, id: "agent-2", label: "codex:1", conversationId: "conv-2" };
  const seen = [];
  ann.doc.on("update", () => seen.push(ann.text.toString()));
  const long = "written by one of two Agents at the same time, word after word after word";
  const first = h.session.submitEdit(agent, { baseRevision: 1, body: HEAD.replace("In progress", `Status ${long}`),
    conversationIds: ["conv-1"] });
  const second = h.session.submitEdit(codex, { baseRevision: 1, body: HEAD.replace("none", `Notes ${long}`),
    conversationIds: ["conv-2"] });
  await new Promise((resolve) => setTimeout(resolve, 12));
  ann.text.insert(0, "Hi ");
  await h.session.commit();
  const interrupted = h.persisted.at(-1);
  await Promise.all([first, second]);
  assert.ok(seen.some((text) => /Status written/u.test(text) && /Notes written/u.test(text)
    && !/Status [^\n]*word after word after word/u.test(text)), "both write before the first is done");
  const final = ann.text.toString();
  assert.match(final, /Status written[^\n]*after word\n/u);
  assert.match(final, /Notes written[^\n]*after word\n/u);
  assert.match(final, /Hi /u, "and the person's word is there");
  const human = h.commits.find((c) => c.principal === "ann");
  assert.ok(human, "the person's edit committed");
  assert.match(human.body, /Status written[^\n]*after word/u, "it keeps the Agent's words still being written");
  const resumed = new PageSession(h.ports);
  cleanups.push(() => resumed.destroy());
  await resumed.ensureLoaded(agent, interrupted);
  assert.match(resumed.markdown(), /Status written[^\n]*after word\n/u);
  assert.match(resumed.markdown(), /Notes written[^\n]*after word\n/u);
  assert.match(resumed.markdown(), /Hi /u);
  assert.equal(await resumed.commit(), null, "recovering both presentations repeats no commit");
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

// Typing words into a structure that already stands must leave no moment a Markdown parser reads otherwise:
// a half-written fence or table swallows what follows, and another Agent's edit rewrites the page from Markdown.
test("an Agent's edit is typed in word by word, and every moment reads back from Markdown as itself", async () => {
  for (const [replacement, steps] of [
    ["Shipped **behind one switch** with [the launch docs](https://xmatrix.sh/docs) and `xmatrix page edit` *today*", 10],
    ["In progress\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter the code.", 5],
    // A table's cells each stand with their first word; the rest of each cell is typed.
    ["| Area | Owner | State |\n| --- | --- | --- |\n| Web | Claude | merged |\n| Mobile | Codex | in review |", 1],
    [`Shipped.\n\n## Plan\n\n${Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ")}\n\n- one\n- two with more\n  - nested`, 30],
    ["会议马上开始，请大家准备好材料。\n\n- 第一项：Web 已上线", 10],
  ]) {
    const h = harness();
    h.ports.writePaceMs = 1;
    const ann = await annConnected(h);
    const seen = frames(ann);
    const body = canonical(HEAD.replace("In progress", replacement));
    await h.session.submitEdit(agent, { baseRevision: 1, body, conversationIds: ["conv-1"] });
    assert.equal(ann.text.toString(), body, replacement);
    assert.equal(h.session.markdown(), head(h));
    assert.ok(seen.length > steps, `${replacement}: typed in ${seen.length} steps`);
    for (const doc of seen) assert.ok(markdownToPageDoc(pageDocToMarkdown(doc)).eq(doc), pageDocToMarkdown(doc));
  }
});

test("typing an Agent's edit reads the page a few times in all, not once a word", async () => {
  const h = harness();
  h.ports.writePaceMs = 1;
  const ann = await annConnected(h);
  const reads = { count: 0 };
  const markdown = h.session.markdown.bind(h.session);
  h.session.markdown = () => { reads.count++; return markdown(); };
  const seen = frames(ann);
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  await h.session.submitEdit(agent, { baseRevision: 1, body: HEAD.replace("In progress", words), conversationIds: [] });
  assert.ok(seen.length >= 30, "typed over many steps");
  assert.ok(reads.count <= 8, `the page was read ${reads.count} times`);
  assert.equal(h.persisted.filter((state) => state.typing).length <= 2, true, "typed words are not stored one by one");
});

test("three Agents type neighbouring lines of one list at once, each from the same revision", async () => {
  const h = harness({ head: LIST });
  h.ports.writePaceMs = 2;
  const ann = await annConnected(h);
  const seen = [];
  ann.doc.on("update", () => seen.push(ann.text.toString()));
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
  const moving = (text) => edits.filter(([, , to]) => text.includes(to.split(" · ")[2].split(" ")[0])
    && !text.includes(to)).length;
  assert.ok(seen.some((text) => moving(text) >= 2), "at least two lines are being typed at the same moment");
});

test("a person typing in the paragraph an Agent is typing into keeps both their words", async () => {
  const h = harness();
  h.ports.writePaceMs = 2;
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

test("an Agent's edit that rewrites another's line while that one is typed in ends as the head", async () => {
  const h = harness({ head: LIST });
  h.ports.writePaceMs = 2;
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

test("committed notices arrive in revision order while Agents type", async () => {
  const h = harness({ head: LIST });
  h.ports.writePaceMs = 2;
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

// Hand-written interleavings cannot cover how Agents typing, people typing and commits fall together: many
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
    h.ports.writePaceMs = 1;
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
function joinCoWriter(h, id = "w-agent", { canEdit = true, resumed = false, streams = false } = {}) {
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
  h.session.connect({ id, principal: agent, canEdit, coWriter: true, ...(streams ? { streams } : {}) }, { resumed });
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
    done: (n) => reply({ type: "done", turn: turnId(n) }),
    /** A runtime streaming from a conversation opens turn `n` itself. */
    open: (n) => reply({ type: "write", turn: n }),
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

test("a co-writing Agent hears what changed when people pause, and stops when someone edits what it writes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const ann = await annConnected(h);
  const writer = joinCoWriter(h);
  writer.write(1, "⟦pass⟧");
  writer.done(1);

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
  writer.write(2, "⟦after \"a first\"⟧\n- a second\n");
  writer.done(2);
  assert.match(ann.text.toString(), /a second/u, "and it writes again");
});

/** Ann on the page, and an Agent that has just joined to co-write it. */
async function annCoWriting() {
  const h = harness();
  const ann = await annConnected(h);
  return { h, ann, writer: joinCoWriter(h) };
}

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
async function annWithStreamingWriter() {
  const h = harness();
  const ann = await annConnected(h);
  const writer = joinCoWriter(h, "w-agent", { streams: true });
  writer.open(1);
  return { h, ann, writer };
}

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

/** A reader's pace a test can count: one character a step, a pause after each sentence. */
const READER = { charsPerSecond: 1000 / CO_WRITER_WRITE_EVERY_MS, sentencePauseMs: 500 };

test("while a person reads the page, an Agent's words reach it at a reader's pace, a breath after each sentence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  h.ports.readerPace = READER;
  const { ann, writer } = await annWithStreamingWriter();
  void h;
  writer.write(1, "⟦after \"none\"⟧\nAb. Cd");
  writer.done(1);
  const written = () => ann.text.toString().slice(ann.text.toString().indexOf("none\n") + 5).trim();
  assert.equal(written(), "A", "one character a step");
  t.mock.timers.tick(CO_WRITER_WRITE_EVERY_MS);
  assert.equal(written(), "Ab");
  t.mock.timers.tick(CO_WRITER_WRITE_EVERY_MS);
  assert.equal(written(), "Ab.", "a sentence ends");
  t.mock.timers.tick(CO_WRITER_WRITE_EVERY_MS);
  assert.equal(written(), "Ab.", "and it pauses there");
  assert.equal(writer.outcomes().length, 0, "the turn is not over while its words are still coming");
  t.mock.timers.tick(READER.sentencePauseMs);
  for (let step = 0; step < 4; step++) t.mock.timers.tick(CO_WRITER_WRITE_EVERY_MS);
  assert.equal(written(), "Ab. Cd");
  assert.deepEqual(writer.outcomes(), [{ type: "outcome", turn: 1, problems: [] }], "it ends once all of it is on the page");
});

test("with nobody reading the page, or for a message's write, an Agent's words go in at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const alone = harness();
  alone.ports.readerPace = READER;
  await alone.session.ensureLoaded(agent);
  const writer = joinCoWriter(alone, "w-agent", { streams: true });
  writer.open(1);
  writer.write(1, "⟦after \"none\"⟧\nNobody waits on this.");
  writer.done(1);
  assert.match(alone.session.markdown(), /none\n\nNobody waits on this\.\n$/u, "nobody reads it: it lands whole");
  const { ann, writer: sending } = await annWithStreamingWriter();
  const read = harness();
  void read;
  sending.done(1);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PAGE_MESSAGE_CO_WRITE);
  encoding.writeVarString(encoder, JSON.stringify({ type: "write", turn: 2, atOnce: true }));
  void encoder;
  void ann;
});
