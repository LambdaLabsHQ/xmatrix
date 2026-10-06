import assert from "node:assert/strict";
import test from "node:test";

import { readMessagePreview, storedMessagePreview } from "../dist/message-preview.js";

test("a stored message preview keeps exactly its two bounded fields", () => {
  const stored = JSON.parse(storedMessagePreview({
    bodyPreview: "Short body", senderSnapshot: { kind: "agent", label: "Codex" }, extra: "dropped",
  }));
  assert.deepEqual(stored, { bodyPreview: "Short body", senderSnapshot: { kind: "agent", label: "Codex" } });
  for (const invalid of [undefined, { bodyPreview: 1, senderSnapshot: {} },
    { bodyPreview: "x".repeat(1_001), senderSnapshot: {} }, { bodyPreview: "x", senderSnapshot: [] }]) {
    assert.throws(() => storedMessagePreview(invalid), /message preview is invalid/u);
  }
  assert.throws(() => storedMessagePreview({ bodyPreview: "x", senderSnapshot: { label: "y".repeat(41_000) } }),
    /message preview is too large/u);
});

test("a message written before previews reads none; a malformed stored preview fails closed", () => {
  assert.equal(readMessagePreview(null), null);
  assert.equal(readMessagePreview(undefined), null);
  assert.deepEqual(readMessagePreview({ bodyPreview: "b", senderSnapshot: { kind: "user" } }),
    { bodyPreview: "b", senderSnapshot: { kind: "user" } });
  assert.throws(() => readMessagePreview({ bodyPreview: "b" }), /stored message preview is invalid/u);
});
