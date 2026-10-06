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
