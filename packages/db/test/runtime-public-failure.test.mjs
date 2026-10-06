import assert from "node:assert/strict";
import test from "node:test";
import { publicLaunchFailureCode, publicLaunchFailureMessage, publicRuntimeErrorCode } from "../dist/runtime-public-failure.js";

test("public launch errors use fixed classifications rather than provider error text", () => {
  assert.match(publicLaunchFailureMessage("daemon_spawn_failed"), /machine could not start/);
  assert.match(publicLaunchFailureMessage("machine_spawn_failed"), /machine could not start/);
  assert.match(publicLaunchFailureMessage("directory_publish_unavailable"), /may already exist/);
  for (const value of ["password=PRIVATE_SENTINEL", "https://private.example/token", "C:\\private\\credentials", "toString", {}]) {
    assert.equal(publicRuntimeErrorCode(value), undefined);
    assert.equal(publicLaunchFailureMessage(value), "Startup failed. Inspect the recorded steps and diagnostic reference before retrying.");
  }
  assert.equal(publicRuntimeErrorCode("runtime_sql_contract_error"), "runtime_sql_contract_error");
});

test("known spawn failures explain the cause and recovery without exposing private stderr", () => {
  const detail = "repo pool lease unavailable (base_ref_unresolved: could not resolve origin default branch after fetch) /private/token=PRIVATE_SENTINEL";
  for (const code of ["daemon_spawn_failed", "machine_spawn_failed"]) {
    assert.equal(publicLaunchFailureCode(code, detail), "repository_base_unresolved");
    const message = publicLaunchFailureMessage(code, detail);
    assert.match(message, /no usable default branch/u);
    assert.match(message, /initial commit/u);
    assert.match(message, /repo:owner\/repository/u);
    assert.doesNotMatch(message, /PRIVATE_SENTINEL|\/private/u);
  }
  assert.equal(publicLaunchFailureCode("machine_spawn_failed", "unknown PRIVATE_SENTINEL"), "machine_spawn_failed");
  assert.doesNotMatch(publicLaunchFailureMessage("machine_spawn_failed", "unknown PRIVATE_SENTINEL"), /PRIVATE_SENTINEL/u);
  assert.equal(publicLaunchFailureCode("runtime_sql_contract_error", detail), "runtime_sql_contract_error");
});
