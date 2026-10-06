import assert from "node:assert/strict";
import test from "node:test";
import { pageReferences } from "../src/github-claim-check.ts";

test("a pull request names page blocks by their links, in the app or public", () => {
  assert.deepEqual(pageReferences([
    "Implements https://xmatrix.sh/app/s-1/pages?page=p-1#search and",
    "(see https://xmatrix.sh/app/s-1/pages?view=pages&page=p-2) and https://xmatrix.sh/p/s-2/p-3#api-v2.",
    "Again https://xmatrix.sh/app/s-1/pages?page=p-1#search",
  ].join("\n")), [
    { spaceId: "s-1", pageId: "p-1", blockId: "search" },
    { spaceId: "s-1", pageId: "p-2", blockId: "" },
    { spaceId: "s-2", pageId: "p-3", blockId: "api-v2" },
  ]);
  assert.deepEqual(pageReferences("Fixes #12 in page:p-1"), [], "only links carry their Space");
  const many = Array.from({ length: 9 }, (_, i) => `https://xmatrix.sh/p/s/p-${i}`).join(" ");
  assert.equal(pageReferences(many).length, 5);
});
