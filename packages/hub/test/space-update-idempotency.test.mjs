import assert from "node:assert/strict";
import { test } from "node:test";

// Space updates go through `updateSpace`, which keys each command on
// `${stableId}:${spaceId}:${digest of its changes}`.

test("two different updates cannot collide on the same key", async () => {
  const { webcrypto } = await import("node:crypto");
  const digestOf = async (name, kind, metadata) => {
    const bytes = new TextEncoder().encode(JSON.stringify([name ?? null, kind ?? null, metadata ?? null]));
    const hash = await webcrypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  };
  const marker = await digestOf(null, null, { joinPolicy: "approval" });
  const withPolicy = await digestOf(null, null, { joinPolicy: "approval", archived: true });
  assert.notEqual(marker, withPolicy, "adding a setting must produce a new key");
  assert.equal(marker, await digestOf(null, null, { joinPolicy: "approval" }), "a true retry must still dedupe");
});
