import { test } from "node:test";
import { assertDocumentationCorpusShard } from "./page-document-corpus.mjs";

test("documentation corpus shard 3 of 4 converts once to canonical form and then stays put", () => {
  assertDocumentationCorpusShard(2, 4);
});
