import assert from "node:assert/strict";
import { test } from "node:test";

import { base64DecodeBytes, base64UrlDecodeBytes, base64UrlEncodeValue } from "../src/relay-v2-primitives.ts";

test("base64 decoding returns every byte value exactly", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.deepEqual(base64DecodeBytes(Buffer.from(bytes).toString("base64")), bytes);
  assert.deepEqual(base64DecodeBytes(""), new Uint8Array());
  // A stored message record is ~100 KiB; it must decode to the same bytes.
  const record = Uint8Array.from({ length: 160 * 1024 }, (_, index) => (index * 31) & 255);
  assert.deepEqual(base64DecodeBytes(Buffer.from(record).toString("base64")), record);
  assert.deepEqual(base64UrlDecodeBytes(base64UrlEncodeValue(record)), record);
});

test("malformed base64 still fails closed", () => {
  assert.throws(() => base64DecodeBytes("not base64!"));
  assert.throws(() => base64UrlDecodeBytes("a+b"), TypeError);
  assert.throws(() => base64UrlDecodeBytes("a"), TypeError);
});
