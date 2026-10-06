import assert from "node:assert/strict";
import test from "node:test";
import { cleanRuntimeOperationFailure } from "../dist/runtime-operation-failure.js";

const failure = { code: "agent_run_not_live", stage: "relay.authenticate", originStage: "authority.request",
  retryable: false, diagnosticId: "diag_11111111-1111-4111-8111-111111111111" };
test("operation failure observations preserve typed fields and discard private error data", () => {
  assert.deepEqual(cleanRuntimeOperationFailure({ ...failure, message: "PRIVATE", token: "PRIVATE", cause: { sql: "PRIVATE" } }), failure);
  for (const delta of [{ code: "PRIVATE TOKEN" }, { stage: "/private/path" }, { retryable: "true" },
    { diagnosticId: "private" }, { originStage: {} }]) {
    assert.equal(cleanRuntimeOperationFailure({ ...failure, ...delta }), undefined);
  }
});
