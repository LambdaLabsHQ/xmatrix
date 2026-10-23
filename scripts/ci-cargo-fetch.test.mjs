import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchRustDependencies } from "./ci-cargo-fetch.mjs";

// No existing owner exercises dependency-transfer retry policy. Protect the
// observed metadata curl-56 failure without allowing retries of validation.
function transferSequence(results) {
  const calls = [];
  const delays = [];
  return {
    calls,
    delays,
    options: {
      run: (...args) => { calls.push(args); return results[calls.length - 1]; },
      delay: async (ms) => { delays.push(ms); },
      output: () => {},
    },
  };
}

const success = { status: 0 };
const reset = { status: 101, stderr: "download of cl/ap/clap_builder failed\nCaused by:\n  [56] Failure when receiving data from the peer (Recv failure: Connection was reset)" };

test("a metadata connection reset recovers by fetching locked dependencies before validation", async () => {
  const sequence = transferSequence([reset, success]);
  await fetchRustDependencies(sequence.options);
  assert.equal(sequence.calls.length, 2);
  assert.deepEqual(sequence.delays, [5_000]);
  for (const [, args, options] of sequence.calls) {
    assert.deepEqual(args, ["fetch", "--locked", "--target", "x86_64-pc-windows-msvc"]);
    assert.equal(options.timeout, 120_000);
  }
});

test("persistent connection resets exhaust exactly three attempts", async () => {
  const sequence = transferSequence([reset, reset, reset]);
  await assert.rejects(fetchRustDependencies(sequence.options), /attempt 3/);
  assert.equal(sequence.calls.length, 3);
  assert.deepEqual(sequence.delays, [5_000, 5_000]);
});

test("successful transfer has no retry", async () => {
  const sequence = transferSequence([success]);
  await fetchRustDependencies(sequence.options);
  assert.equal(sequence.calls.length, 1);
  assert.deepEqual(sequence.delays, []);
});

test("a registry HTTP 503 recovers without broadening retry to authorization errors", async () => {
  const sequence = transferSequence([
    { status: 101, stderr: "failed to get successful HTTP response: 503 Service Unavailable" }, success,
  ]);
  await fetchRustDependencies(sequence.options);
  assert.equal(sequence.calls.length, 2);
  assert.deepEqual(sequence.delays, [5_000]);
});

for (const [reason, result] of [
  ["invalid lockfile", { status: 101, stderr: "the lock file needs to be updated but --locked was passed" }],
  ["authentication", { status: 101, stderr: "failed to get successful HTTP response: 403 Forbidden" }],
  ["checksum", { status: 101, stderr: "checksum for dependency changed between lock files" }],
  ["timeout", { status: null, error: new Error("ETIMEDOUT"), stderr: reset.stderr }],
  ["signal", { status: null, signal: "SIGTERM", stderr: reset.stderr }],
]) {
  test(`${reason} fails immediately`, async () => {
    const sequence = transferSequence([result]);
    await assert.rejects(fetchRustDependencies(sequence.options), /attempt 1/);
    assert.equal(sequence.calls.length, 1);
    assert.deepEqual(sequence.delays, []);
  });
}
