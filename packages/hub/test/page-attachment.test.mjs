import assert from "node:assert/strict";
import test from "node:test";

import { attachConversationToPage } from "../src/product-page-attachment.ts";

const summary = (pageId, parentPageId, title) => ({ pageId, parentPageId, title, position: "V", accessMode: "open",
  headRevision: 1, agentSuggestOnly: false, canEdit: true, updatedAt: "2026-09-26T00:00:00Z" });

function fakePages({ links = [], tree = [] } = {}) {
  const linked = [];
  return {
    linked,
    spaceOfConversation: async () => ({ spaceId: "space-1" }),
    links: async () => ({ links }),
    tree: async () => ({ pages: tree }),
    link: async (input) => { linked.push(input); return { link: {} }; },
  };
}

test("Jev chooses the page a new conversation is about, by its path, and it is linked as Jev's", async () => {
  const pages = fakePages({ tree: [summary("company", null, "Company"), summary("relay", "company", "Relay"),
    summary("billing", "company", "Billing")] });
  let asked;
  const result = await attachConversationToPage({ env: {}, conversationId: "conv-1", actorUserId: "u1",
    body: "The relay storage migration is stuck on the shard move", pages,
    evaluate: async (input) => { asked = input; return { answers: { page: { type: "choice", choice: "p1" } } }; } });
  assert.equal(result.attachedPageId, "relay");
  assert.equal(asked.questions.page.criteria.p1, "Company › Relay");
  assert.ok(asked.questions.page.criteria.none);
  assert.deepEqual(pages.linked.map((link) => [link.pageId, link.source, link.conversationId]), [["relay", "jev", "conv-1"]]);
});

test("nothing is asked when the conversation is already linked or there are no pages", async () => {
  const evaluate = async () => { throw new Error("must not be asked"); };
  assert.equal((await attachConversationToPage({ env: {}, conversationId: "c", actorUserId: "u", body: "x",
    pages: fakePages({ links: [{ pageId: "p" }], tree: [summary("p", null, "P")] }), evaluate })).reason, "already_linked");
  assert.equal((await attachConversationToPage({ env: {}, conversationId: "c", actorUserId: "u", body: "x",
    pages: fakePages(), evaluate })).reason, "no_pages");
});

test("'none' and unknown choices link nothing", async () => {
  for (const choice of ["none", "p9"]) {
    const pages = fakePages({ tree: [summary("p", null, "P")] });
    const result = await attachConversationToPage({ env: {}, conversationId: "c", actorUserId: "u", body: "hi",
      pages, evaluate: async () => ({ answers: { page: { type: "choice", choice } } }) });
    assert.equal(result.attachedPageId, null);
    assert.equal(pages.linked.length, 0);
  }
});

test("a page past the sixtieth is still a candidate, put with the line that says how it stands", async () => {
  const tree = [summary("root", null, "Root"), ...Array.from({ length: 150 }, (_, index) => ({
    ...summary(`page-${index}`, "root", `Page ${index}`), updatedAt: `2026-09-26T00:00:${String(index % 60).padStart(2, "0")}Z` }))];
  tree[140].summary = { text: "Relay shard move\nis stuck", revision: 1, at: "2026-09-26T00:00:00Z" };
  const pages = fakePages({ tree });
  const asked = [];
  const result = await attachConversationToPage({ env: {}, conversationId: "c", actorUserId: "u", body: "shard move", pages,
    evaluate: async (input) => {
      asked.push(input);
      const criteria = input.questions.page.criteria;
      const choice = Object.keys(criteria).find((key) => criteria[key].includes("Relay shard move is stuck"));
      return { answers: { page: { type: "choice", choice: choice ?? "none" } } };
    } });
  assert.equal(result.attachedPageId, "page-139");
  assert.equal(asked.length, 1);
  assert.equal(Object.keys(asked[0].questions.page.criteria).length, 152);
  assert.ok(Object.values(asked[0].questions.page.criteria).includes("Root › Page 139 — Relay shard move is stuck"));
});

test("a Space too large for one question is asked in batches, then among each batch's choice", async () => {
  const about = "状态".repeat(200);
  const tree = Array.from({ length: 300 }, (_, index) => ({ ...summary(`page-${index}`, null, `Page ${index}`),
    summary: { text: about, revision: 1, at: "2026-09-26T00:00:00Z" } }));
  const pages = fakePages({ tree });
  const asked = [];
  const result = await attachConversationToPage({ env: {}, conversationId: "c", actorUserId: "u", body: "hi", pages,
    evaluate: async (input) => {
      asked.push(input);
      assert.ok(new TextEncoder().encode(JSON.stringify(input)).byteLength < 65_536);
      const criteria = input.questions.page.criteria;
      // Every batch names its first page; the last question, asked among those, takes its second.
      const last = Object.keys(criteria).length - 1 < 10;
      return { answers: { page: { type: "choice", choice: last ? "p1" : "p0" } } };
    } });
  const batches = asked.length - 1;
  assert.ok(batches > 1 && batches <= 6);
  assert.equal(Object.keys(asked.at(-1).questions.page.criteria).length, batches + 1);
  assert.equal(result.reason, "attached");
  assert.equal(pages.linked.length, 1);
});
