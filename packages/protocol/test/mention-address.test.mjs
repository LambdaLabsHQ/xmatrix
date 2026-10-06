import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

/**
 * The Hub and the web client each had their own copy of this grammar, written
 * to agree and not agreeing. The web rule demanded that the character after a
 * name come from a fixed punctuation set, so `@codex的输出` was a mention to
 * the Hub -- which notified codex -- and plain text to the client, which drew
 * no chip. Somebody got a notification for a mention they could not see.
 *
 * These tests pin the shared rules so the two sides cannot drift again.
 */
const {
  MENTION_BROADCAST_NAMES,
  canonicalMentionToken,
  mentionAddressTokens,
  scanMentionAddresses,
} = await loadTypescriptModule(new URL("../src/mention-address.ts", import.meta.url));

const TOKENS = mentionAddressTokens(["codex", "codex-mba", "claude", "yiming-hu"]);

function matches(body, tokens = TOKENS) {
  return scanMentionAddresses(body, tokens).map((match) => ({
    token: match.token,
    text: body.slice(match.start, match.end),
  }));
}

test("the longest token wins, so a prefix never steals a mention", () => {
  assert.deepEqual(matches("ping @codex-mba now"), [{ token: "codex-mba", text: "@codex-mba" }]);
});

test("a name has to end where the mention ends", () => {
  assert.deepEqual(matches("@codexfoo ping"), []);
});

test("a mention against CJK text is still a mention", () => {
  // The whole reason this module exists: judging by what may *follow* a name,
  // rather than by whether the name ended, dropped every mention written
  // against Chinese text on one side and kept it on the other.
  assert.deepEqual(matches("@codex的输出有问题"), [{ token: "codex", text: "@codex" }]);
  assert.deepEqual(matches("@yiming-hu你看下"), [{ token: "yiming-hu", text: "@yiming-hu" }]);
});

test("a mention opens inside CJK brackets", () => {
  assert.deepEqual(matches("麻烦（@claude）看一下"), [{ token: "claude", text: "@claude" }]);
});

test("an @ that does not open a mention is not one", () => {
  assert.deepEqual(matches("mail me at legend@codex.dev"), []);
});

test("control tails belong to the mention, not to the identity", () => {
  assert.deepEqual(matches("@codex:new:LambdaLabsHQ/xmatrix go"), [
    { token: "codex", text: "@codex:new:LambdaLabsHQ/xmatrix" },
  ]);
  assert.deepEqual(matches("@codex:2:handoff:@claude"), [
    { token: "codex", text: "@codex:2:handoff:@claude" },
  ]);
});

test("a handoff tail does not also address the successor", () => {
  // The successor's `@` sits inside the consumed tail; rescanning it would ask
  // for two subjects when the writer named one.
  assert.equal(matches("@codex:2:handoff:@claude").length, 1);
});

test("the full-width @ addresses the same person", () => {
  assert.deepEqual(matches("＠codex look"), [{ token: "codex", text: "＠codex" }]);
});

test("case is not part of an address", () => {
  assert.deepEqual(matches("@CODEX look"), [{ token: "codex", text: "@CODEX" }]);
  assert.equal(canonicalMentionToken("  CoDeX  "), "codex");
});

test("every mention in a body is reported, in order", () => {
  assert.deepEqual(matches("@codex and @claude and @codex again"), [
    { token: "codex", text: "@codex" },
    { token: "claude", text: "@claude" },
    { token: "codex", text: "@codex" },
  ]);
});

test("tokens are deduped and ordered longest first", () => {
  assert.deepEqual(mentionAddressTokens(["b", "aaa", "b", "  AAA  ", "cc", ""]), ["aaa", "cc", "b"]);
});

test("no tokens means no mentions rather than an error", () => {
  assert.deepEqual(scanMentionAddresses("@codex", []), []);
  assert.deepEqual(scanMentionAddresses("", TOKENS), []);
});

test("broadcast names are stated once for both sides to share", () => {
  assert.deepEqual([...MENTION_BROADCAST_NAMES].sort(), ["all", "channel", "everyone", "here"]);
  const tokens = mentionAddressTokens([...MENTION_BROADCAST_NAMES, "codex"]);
  assert.deepEqual(matches("@everyone ship it", tokens), [
    { token: "everyone", text: "@everyone" },
  ]);
});
