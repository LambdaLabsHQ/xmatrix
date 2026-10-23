import assert from "node:assert/strict";
import test from "node:test";

import { discussionHead, splitDiscussionHead } from "../dist/index.js";

const href = "https://xmatrix.sh/app/s/pages?page=p-relay#status";

test("a discussion's first message opens with its passage and where it came from, and comes apart again", () => {
  const head = discussionHead("First line\n\nSecond [line] @claude", { label: "Relay [ops] › Status", href });
  assert.equal(head, `> First line\n>\n> Second [line] @claude\n\n— [Relay \\[ops\\] › Status](${href})\n\n`);
  assert.deepEqual(splitDiscussionHead(`${head}@codex is this still true?`), {
    quote: "First line\n\nSecond [line] @claude", label: "Relay [ops] › Status", href, rest: "@codex is this still true?" });
  // A head with nothing written after it is still a head.
  assert.equal(splitDiscussionHead(head.trimEnd())?.rest, "");
});

test("a link Markdown would break keeps its destination whole", () => {
  const spaced = "https://xmatrix.sh/app/s/pages?page=p#a b(c)";
  const head = discussionHead("x", { label: "p", href: spaced });
  assert.equal(head, "> x\n\n— [p](<https://xmatrix.sh/app/s/pages?page=p#a b(c)>)\n\n");
  assert.equal(splitDiscussionHead(`${head}hi`)?.href, spaced);
});

test("other messages, and quotes without a source line, have no head", () => {
  assert.equal(splitDiscussionHead("just words"), null);
  assert.equal(splitDiscussionHead("> a quote\n\nand a reply"), null);
  assert.equal(splitDiscussionHead("intro\n> a quote\n\n— [x](y)\n\nrest"), null);
});
