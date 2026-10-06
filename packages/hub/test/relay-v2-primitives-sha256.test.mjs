import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { sha256Sync } from "../src/relay-v2-primitives.ts";

const encoder = new TextEncoder();
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const VECTORS = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
];

test("sha256Sync matches the published SHA-256 test vectors", () => {
  for (const [input, digest] of VECTORS) assert.equal(hex(sha256Sync(encoder.encode(input))), digest);
});

test("sha256Sync matches node:crypto across padding and multi-block lengths", () => {
  for (let length = 0; length <= 130; length += 1) {
    const input = encoder.encode("x".repeat(length));
    assert.equal(hex(sha256Sync(input)), createHash("sha256").update(input).digest("hex"), `length ${length}`);
  }
});
