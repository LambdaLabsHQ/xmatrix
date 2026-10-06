import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RuntimeSocketState,
  runtimeTransportError,
} from "../src/runtime-transport/ordered-socket-dispatch.ts";
import {
  RuntimeApprovalOperationError,
  RuntimeAuthorityOperationError,
  RuntimeClientOperationError,
  runtimeFailureOrigin,
} from "../src/runtime-transport/runtime-operation-failure.ts";
import { PostgresAgentInstancePort } from "../src/runtime-transport/postgres-agent-instance-port.ts";
import { InvalidAuthTokenError } from "../src/auth.ts";

test("socket errors preserve actionable product messages only through a typed producer", async () => {
  assert.equal(
    runtimeTransportError(new RuntimeClientOperationError("channel_access_changed"), "Request failed"),
    "You no longer have access to this Channel",
  );
});

test("socket errors never expose retired or internal storage architecture", () => {
  for (const message of [
    "Relay Core internal operation failed",
    "Relay authority request failed",
    "Durable Object storage failed",
    "SQLite constraint failed",
    "D1 database unavailable",
  ]) {
    assert.equal(runtimeTransportError(new Error(message), "Request could not be completed"),
      "Request could not be completed");
  }
  assert.equal(runtimeTransportError("unexpected rejection", "Request could not be completed"),
    "Request could not be completed");
});

test("a structured authority error keeps classification and correlation through the socket", async () => {
  const diagnosticId = "diag_11111111-1111-4111-8111-111111111111";
  const error = new RuntimeAuthorityOperationError("get-run", 503, {
    code: "postgres_runtime_unavailable", retryable: true, diagnosticId,
    error: "password=do-not-expose", details: { token: "do-not-expose" },
  });
  const output = [];
  const sockets = new RuntimeSocketState("test", (requestId, message, failure) => ({ requestId, message, failure }), () => {});
  await sockets.answerOperation({ send: value => output.push(JSON.parse(value)) }, "request-1", "Registration failed", async () => { throw error; });
  assert.deepEqual(output, [{ requestId: "request-1", message: "Registration failed", failure: {
    code: "postgres_runtime_unavailable", diagnosticId, retryable: true, stage: "authority.request",
  } }]);
  assert.doesNotMatch(JSON.stringify(output), /password|do-not-expose|token/);
});

test("a permanent authority rejection never becomes automatically retryable", async () => {
  const failure = new RuntimeAuthorityOperationError("append-message", 403, {
    code: "agent_run_forbidden", retryable: true, diagnosticId: "Bearer private-token",
  }).failure;
  assert.equal(failure.retryable, false);
  assert.match(failure.diagnosticId, /^diag_[a-f0-9-]{36}$/);
});


test("unclassified exception text and duck-typed public fields never cross the socket", async () => {
  const outputs = [];
  const sockets = new RuntimeSocketState("test", (requestId, message, failure) => ({ requestId, message, failure }), () => {});
  for (const error of [new Error("password=PRIVATE_SENTINEL"), new Error("C:\\private\\token.txt"),
    { message: "PRIVATE_SENTINEL", publicMessage: "PRIVATE_SENTINEL", failure: { code: "forbidden" } }]) {
    assert.equal(runtimeTransportError(error, "Request failed"), "Request failed");
    await sockets.answerOperation({ send: raw => outputs.push(JSON.parse(raw)) }, "request", "Request failed",
      async () => { throw error; }, () => "relay.bind_delivery");
  }
  assert.doesNotMatch(JSON.stringify(outputs), /PRIVATE_SENTINEL|private|password/);
  assert.ok(outputs.every(output => output.failure.stage === "relay.bind_delivery" && output.failure.originStage === "runtime.session"));
});

test("a missing run keeps its own code so the Machine Daemon can stop reporting it", async () => {
  // The daemon drops a run it can never report again, and it decides that from
  // the code. Rewriting this one to the generic rejection is what made it
  // re-send the same exit forever.
  const missing = new RuntimeAuthorityOperationError("machine-run-exited", 404, {
    code: "run_not_found", error: "Machine Daemon report run is not owned by this principal",
  });
  assert.equal(missing.failure.code, "run_not_found");
  assert.equal(missing.failure.retryable, false);

  // A code outside the public set is still withheld: this widens the allowlist
  // by exactly one entry, it does not open the classifier to authority detail.
  const internal = new RuntimeAuthorityOperationError("machine-run-exited", 404, {
    code: "postgres_relation_missing", error: "relation data.runs does not exist",
  });
  assert.equal(internal.failure.code, "runtime.authority_rejected");
});

test("a missing approval secret keeps actionable classification without private catalog details", async () => {
  const error = new RuntimeApprovalOperationError("secret-and-request-broker", 404,
    { code: "secret_not_found", error: "Secret 'PRIVATE_ALIAS' not found", retryable: false });
  assert.equal(error.failure.code, "secret_not_found");
  assert.equal(error.failure.retryable, false);
  const message = runtimeTransportError(error, "Request failed");
  assert.match(message, /required secret has not been saved/);
  assert.doesNotMatch(message, /PRIVATE_ALIAS|runtime.authority_rejected/);
});

test("a secret the registration no longer allows names its fix instead of a generic rejection", () => {
  const error = new RuntimeApprovalOperationError("machine-daemon-control", 403, {
    code: "secret_not_admitted", error: "A requested secret is not configured for this Agent's registration",
    retryable: false,
  });
  assert.equal(error.failure.code, "secret_not_admitted");
  assert.match(error.publicMessage, /no longer allows a requested secret/);
  assert.match(error.publicMessage, /code=secret_not_admitted/);
  assert.doesNotMatch(error.publicMessage, /runtime\.authority_rejected/);
});

test("an unclassified failure logs where it was thrown, never what it said", () => {
  function authenticationBinding() { throw new TypeError("token for user-secret@example.test expired"); }
  let error;
  try { authenticationBinding(); } catch (caught) { error = caught; }
  const origin = runtimeFailureOrigin(error);
  assert.equal(origin.errorClass, "TypeError");
  assert.equal(origin.origin[0], "authenticationBinding");
  assert.doesNotMatch(JSON.stringify(origin), /user-secret|expired/u);
  assert.deepEqual(runtimeFailureOrigin("plain text"), { errorClass: "string", origin: [] });
});

async function capturingConsole(callback) {
  const logged = { error: [], warn: [] };
  const previous = { error: console.error, warn: console.warn };
  console.error = (...args) => { logged.error.push(args); };
  console.warn = (...args) => { logged.warn.push(args); };
  try {
    await callback();
  } finally {
    console.error = previous.error;
    console.warn = previous.warn;
  }
  return logged;
}

function credentialPort(authenticate) {
  return new PostgresAgentInstancePort({
    authenticate,
    runtime: { async getRun() { throw new Error("unexpected Run read"); }, async transition() { return {}; } },
    history: { async join() {}, async leave() {}, async replay() {}, async history() {} },
    signals: { async publish() {} },
  });
}

/** The connect path: authenticate inside answerOperation with the failing stage. */
async function connectWith(port) {
  const output = [];
  const sockets = new RuntimeSocketState("test", (requestId, message, failure) => ({ requestId, message, failure }), () => {});
  const logged = await capturingConsole(() => sockets.answerOperation(
    { send: (raw) => output.push(JSON.parse(raw)) }, "connect-1", "Agent session request could not be completed",
    () => port.authenticate({ type: "agent_instance_connect", token: "stale", identityId: "agent", name: "Agent" }),
    () => "relay.authenticate"));
  return { logged, output };
}

test("an expired Agent run credential is answered by code and never reported as a Hub error (XMATRIX-HUB-65)", async () => {
  const { logged, output } = await connectWith(credentialPort(async () => { throw new InvalidAuthTokenError(); }));
  assert.deepEqual(logged.error, []);
  assert.deepEqual(logged.warn.map(([message]) => message),
    ["xMatrix runtime product rejection", "xMatrix runtime failure stage"]);
  assert.equal(output.length, 1);
  assert.equal(output[0].message, "The Agent run credential is invalid or expired. Reconnect with a fresh credential.");
  assert.equal(output[0].failure.code, "agent_run_credential_invalid");
  assert.equal(output[0].failure.retryable, false);
  assert.equal(output[0].failure.stage, "relay.authenticate");
});

test("a credential check that fails for another reason stays a reported session failure", async () => {
  const { logged, output } = await connectWith(credentialPort(async () => { throw new Error("signing key read failed"); }));
  assert.deepEqual(logged.error.map(([message]) => message),
    ["xMatrix runtime session failure", "xMatrix runtime failure stage"]);
  assert.deepEqual(logged.warn, []);
  assert.equal(output[0].failure.code, "runtime.session_failed");
  assert.equal(output[0].message, "Agent session request could not be completed");
});
