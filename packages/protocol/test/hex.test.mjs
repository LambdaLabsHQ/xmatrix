import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";
import { sourceOffenders } from "./repository-sources.mjs";

const { hmacBytes, hmacHex, lowercaseHex, sha256Hex, sha256BytesSync, timingSafeEqual, utf8ByteLength } = await loadTypescriptModule(new URL("../src/hex.ts", import.meta.url));

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test("utf8ByteLength is the byte length of the UTF-8 encoding", () => {
  assert.equal(utf8ByteLength(""), 0);
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("é"), 2);
  assert.equal(utf8ByteLength("你好"), 6);
  assert.equal(utf8ByteLength("😀"), 4);
  for (const value of ["", "a", "é", "你好", "😀", "x".repeat(1_000)]) {
    assert.equal(utf8ByteLength(value), new TextEncoder().encode(value).byteLength);
  }
});

test("lowercaseHex writes two lowercase digits per byte", () => {
  assert.equal(lowercaseHex(new Uint8Array([0, 15, 16, 255])), "000f10ff");
  assert.equal(lowercaseHex(new Uint8Array([0, 15, 16, 255]).buffer), "000f10ff");
  assert.equal(lowercaseHex(new Uint8Array([9, 0, 15, 16, 255, 9]).subarray(1, 5)), "000f10ff");
  assert.equal(lowercaseHex(new Uint8Array()), "");
});

test("sha256Hex hashes UTF-8 text or raw bytes", async () => {
  assert.equal(await sha256Hex("abc"), ABC_SHA256);
  assert.equal(await sha256Hex(new Uint8Array([97, 98, 99])), ABC_SHA256);
  assert.equal(await sha256Hex(new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4)), ABC_SHA256);
});

test("sha256BytesSync matches the digest for callers that cannot await", () => {
  assert.equal(lowercaseHex(sha256BytesSync(new Uint8Array())), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  for (let length = 0; length <= 130; length += 1) {
    const input = new TextEncoder().encode("x".repeat(length));
    assert.equal(lowercaseHex(sha256BytesSync(input)), createHash("sha256").update(input).digest("hex"), `length ${length}`);
  }
});

const EVERY_PACKAGE = ["packages/protocol/src/", "packages/db/src/", "packages/hub/src/", "apps/web/src/", "apps/desktop/src/"];

// Sites that print hex digits for something other than bytes.
const NOT_BYTES = new Set([
  "apps/desktop/src/daemon-management-overlay-filesystem.ts", // percent-encodes path characters
]);

test("no package writes another bytes-to-hex encoder", () => {
  const offenders = sourceOffenders(EVERY_PACKAGE, (source, relative) =>
    source.includes(".toString(16).padStart(2") && relative !== "packages/protocol/src/hex.ts" && !NOT_BYTES.has(relative));
  assert.deepEqual(offenders, [], "use lowercaseHex or sha256Hex from @xmatrix/protocol");
});

// A byte-length expression measured by encoding text again, wherever it is
// spelled: the one implementation is utf8ByteLength in protocol/src/hex.ts.
const ENCODED_BYTE_LENGTH = /\.encode\([^)]*\)\.(?:byteLength|length)\b/u;

test("no package measures UTF-8 bytes with its own encode", () => {
  const offenders = sourceOffenders(["packages/protocol/src/", "packages/db/src/", "packages/hub/src/"],
    (source, relative) => relative !== "packages/protocol/src/hex.ts" && ENCODED_BYTE_LENGTH.test(source));
  assert.deepEqual(offenders, [], "use utf8ByteLength from @xmatrix/protocol");
});

test("hmacHex and hmacBytes are the HMAC of UTF-8 text under a UTF-8 secret", async () => {
  for (const [hash, node] of [["SHA-256", "sha256"], ["SHA-1", "sha1"]]) {
    for (const [secret, message] of [["key", "The quick brown fox jumps over the lazy dog"], ["秘密", "体 é 😀"], ["s", ""]]) {
      const expected = createHmac(node, secret).update(message).digest();
      assert.equal(await hmacHex(hash, secret, message), expected.toString("hex"));
      assert.deepEqual(Buffer.from(await hmacBytes(hash, secret, message)), expected);
    }
  }
});

test("timingSafeEqual is string equality", () => {
  assert.equal(timingSafeEqual("", ""), true);
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("é", "e"), false);
});

// Sites that import an HMAC key for something other than signing UTF-8 text once.
const OWN_HMAC_KEY = new Set([
  "packages/hub/src/diagnostics.ts", // caches the imported key across calls
  "packages/hub/src/relay-r2-capability.ts", // keys are raw bytes and also verify
]);

test("no package writes another HMAC or constant-time comparison", () => {
  const offenders = sourceOffenders(EVERY_PACKAGE, (source, relative) => relative !== "packages/protocol/src/hex.ts" &&
    ((/name: "HMAC"/u.test(source) && !OWN_HMAC_KEY.has(relative)) || /\|=[^;\n]*\^/u.test(source)));
  assert.deepEqual(offenders, [], "use hmacHex, hmacBytes or timingSafeEqual from @xmatrix/protocol");
});
