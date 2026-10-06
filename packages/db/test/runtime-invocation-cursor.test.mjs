import assert from "node:assert/strict";
import test from "node:test";
import { decodeInvocationPageCursor, encodeInvocationPageCursor } from "../dist/runtime-invocation-cursor.js";
test("invocation cursors preserve microsecond positions and their exact query scope", () => {
  const position = { launch: ["2026-09-13 00:00:00.123456+00", "launch:one"], rejection: null, continuation: null, execution: null, target: null };
  const cursor = encodeInvocationPageCursor(position, "scope");
  assert.deepEqual(decodeInvocationPageCursor(cursor, "scope"), position);
  assert.throws(() => decodeInvocationPageCursor(cursor, "other-scope"));
  assert.equal(encodeInvocationPageCursor({ launch: null, rejection: null }, "scope"), null);
});

test("continuation pages retain their own position and old cursors never restart that lane", () => {
  const position = { launch: null, rejection: null, continuation: ["2026-09-13T00:00:00.123456Z", "run:one"], execution: null, target: null };
  assert.deepEqual(decodeInvocationPageCursor(encodeInvocationPageCursor(position, "scope"), "scope"), position);
  const legacy = JSON.stringify({ version: 1, scope: "scope", launch: ["2026-09-13", "launch:one"], rejection: null });
  assert.equal(decodeInvocationPageCursor(legacy, "scope").continuation, null);
});
test("malformed positions and exhausted cursors cannot restart a completed lane", () => {
  for (const value of ["null", "{}", "[]", '{"version":1,"scope":"scope","launch":null,"rejection":null}',
    JSON.stringify({ version: 1, scope: "scope", launch: null, rejection: ["invalid-date", "id", 1] }),
    JSON.stringify({ version: 1, scope: "scope", launch: null, rejection: ["2026-09-13", "id", 51] })]) {
    assert.throws(() => decodeInvocationPageCursor(value, "scope"));
  }
});

test("execution history has an independent cursor and older cursors do not start it halfway through", () => {
  const position = { launch: null, rejection: null, continuation: null,
    execution: ["2026-09-13T00:00:00.123456Z", "binding:1"], target: null };
  assert.deepEqual(decodeInvocationPageCursor(encodeInvocationPageCursor(position, "scope"), "scope"), position);
  const old = JSON.stringify({ version: 1, scope: "scope", launch: ["2026-09-13", "launch"], rejection: null, continuation: null });
  assert.equal(decodeInvocationPageCursor(old, "scope").execution, null);
});


test("original mention targets page independently and are absent from older cursors", () => {
  const position = { launch: null, rejection: null, continuation: null, execution: null,
    target: ["2026-09-13T00:00:00.123456Z", "target-id"] };
  assert.deepEqual(decodeInvocationPageCursor(encodeInvocationPageCursor(position, "scope"), "scope"), position);
  const old = JSON.stringify({ version: 1, scope: "scope", launch: ["2026-09-13", "launch"], rejection: null });
  assert.equal(decodeInvocationPageCursor(old, "scope").target, null);
});
