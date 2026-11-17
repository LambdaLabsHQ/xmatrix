import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { markdownToPageDoc, pageDocToMarkdown } from "../dist/page-document.js";

const docsRoot = new URL("../../../docs/", import.meta.url);

function documentationMarkdown() {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const entry = new URL(name, dir);
    if (statSync(entry).isDirectory()) return walk(new URL(`${name}/`, dir));
    return name.endsWith(".md") ? [entry] : [];
  });
  return walk(docsRoot).sort((left, right) => left.pathname.localeCompare(right.pathname));
}

/**
 * One page converts to canonical form and then stays put. Both assertions share
 * the original and canonical documents: reparsing either adds no evidence.
 */
export function assertRoundTrip(input, label) {
  const original = markdownToPageDoc(input);
  const once = pageDocToMarkdown(original);
  const canonical = markdownToPageDoc(once);
  assert.equal(pageDocToMarkdown(canonical), once, label);
  assert.ok(canonical.eq(original), `${label}: canonical form reads as the same document`);
}

/**
 * Every documentation page in one shard of the corpus. The shards are separate
 * test files so the runner's file concurrency parses the corpus in parallel
 * instead of one file holding the lane for the whole corpus. A strided shard
 * covers each page exactly once whatever the corpus size.
 */
export function assertDocumentationCorpusShard(index, count) {
  const docsPrefix = fileURLToPath(docsRoot);
  const pages = documentationMarkdown();
  for (let at = index; at < pages.length; at += count) {
    const file = pages[at];
    const label = path.relative(docsPrefix, fileURLToPath(file)).replaceAll("\\", "/");
    assertRoundTrip(readFileSync(file, "utf8"), label);
  }
}
