import assert from "node:assert/strict";
import { test } from "node:test";

import {
  captureServerErrorDiagnostic,
  safeServerDiagnosticId,
} from "../src/server-error-diagnostic.ts";

test("server diagnostics correlate a safe id with a bounded cause chain", () => {
  const original = console.error;
  const writes = [];
  console.error = (...args) => writes.push(args);
  try {
    const root = Object.assign(new Error(`root\u0000${"x".repeat(1_200)}`), {
      code: "SQLITE_CONSTRAINT",
    });
    const outer = new Error("outer", { cause: root });
    const diagnostic = captureServerErrorDiagnostic("machine_daemon_issue", outer, {
      phase: "idempotency commit",
    });

    assert.match(diagnostic.diagnosticId, /^diag_[0-9a-f-]{36}$/u);
    assert.equal(diagnostic.causes.length, 2);
    assert.equal(diagnostic.causes[1].code, "SQLITE_CONSTRAINT");
    assert.equal(diagnostic.causes[1].message.includes("\u0000"), false);
    assert.equal(diagnostic.causes[1].message.length, 1_000);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "xMatrix server operation failed");
    assert.equal(writes[0][1].diagnosticId, diagnostic.diagnosticId);
    assert.equal(writes[0][1].phase, "idempotency commit");
  } finally {
    console.error = original;
  }
});

test("only canonical opaque diagnostic ids cross response boundaries", () => {
  const valid = "diag_12345678-1234-1234-1234-123456789abc";
  assert.equal(safeServerDiagnosticId(valid), valid);
  assert.equal(safeServerDiagnosticId("diag_private SQL failure"), undefined);
  assert.equal(safeServerDiagnosticId("12345678-1234-1234-1234-123456789abc"), undefined);
});

test("server diagnostics stop cyclic and overlong cause chains", () => {
  const original = console.error;
  console.error = () => {};
  try {
    const errors = Array.from({ length: 6 }, (_, index) => new Error(`error-${index}`));
    for (let index = 0; index < errors.length - 1; index += 1) {
      errors[index].cause = errors[index + 1];
    }
    errors[5].cause = errors[0];
    const diagnostic = captureServerErrorDiagnostic("bounded", errors[0]);
    assert.deepEqual(diagnostic.causes.map((cause) => cause.message), [
      "error-0",
      "error-1",
      "error-2",
      "error-3",
    ]);
  } finally {
    console.error = original;
  }
});
