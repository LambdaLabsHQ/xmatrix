import assert from "node:assert/strict";
import test from "node:test";

import { loneMessageReference, pageReferenceSpans, pageReferenceToken } from "../dist/index.js";

const pageId = "0b6c3f2e-1d1a-4c55-9a51-3e0f6d7c8b90";
const channelId = "da7dacaf-696f-477d-811e-a7cf8311a523";

test("page references carry an optional section and revision", () => {
  const text = `see page:${pageId}#发布-计划 (r12) and page:${pageId.toUpperCase()}.`;
  assert.deepEqual(pageReferenceSpans(text).map(({ pageId: id, blockId, revision, text: raw }) =>
    [id, blockId, revision, raw]), [
    [pageId, "发布-计划", 12, `page:${pageId}#发布-计划 (r12)`],
    [pageId, null, null, `page:${pageId.toUpperCase()}`],
  ]);
  assert.equal(pageReferenceToken(pageId.toUpperCase(), "goals"), `page:${pageId}#goals`);
  assert.equal(pageReferenceToken(pageId, null), `page:${pageId}`);
});

test("a code span holding exactly one reference becomes a chip", () => {
  assert.equal(loneMessageReference(` channel:${channelId} `)?.kind, "channel");
  assert.equal(loneMessageReference(`page:${pageId}#goals`)?.kind, "page");
  assert.equal(loneMessageReference(`channel:${channelId} page:${pageId}`), null);
  assert.equal(loneMessageReference(`xmatrix channel history channel:${channelId}`), null);
});
