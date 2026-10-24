import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT } from "jose";
import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { signMachineDaemonCredential, verifyMachineDaemonCredential } from "../src/connections/machine-daemon/auth.ts";
import { RuntimeSocketState } from "../src/runtime-transport/ordered-socket-dispatch.ts";
import { sentryEventMetadata } from "../src/connectors/actions/sentry-event-metadata.ts";
import { captureErrorReports, exceptionEvents } from "./support/error-reports.mjs";

const env = { BETTER_AUTH_SECRET: "PRIVATE_SENTINEL_signing_key" };
const principal = { ownerUserId: "PRIVATE_SENTINEL_owner", ownerEmail: "PRIVATE_SENTINEL@example.test", machineId: "PRIVATE_SENTINEL_machine" };

function credential({ key = env.BETTER_AUTH_SECRET, claims = principal, issuer = "xmatrix-hub-machine-control",
  audience = "xmatrix-machine-daemon", expiration = "30m", notBefore = 0, algorithm = "HS256" } = {}) {
  return new SignJWT({ xmatrixMachineDaemon: claims }).setProtectedHeader({ alg: algorithm, typ: "JWT" })
    .setIssuer(issuer).setAudience(audience).setExpirationTime(expiration).setNotBefore(notBefore)
    .sign(new TextEncoder().encode(`xmatrix-machine-daemon\0${key}`));
}

// Existing identity tests prove accept/reject, but not why a rejected refresh
// reaches Sentry. This covers the real verifier and the actual report envelope.
test("daemon credential failures retain a finite reason through socket reporting (XMATRIX-HUB-A7/7H)", async (t) => {
  const envelopes = captureErrorReports(t);
  const sockets = new RuntimeSocketState("test", (_id, message, failure) => ({ message, failure }), () => {});
  const cases = [
    ["expired", await credential({ expiration: 1 })],
    ["not_yet_valid", await credential({ notBefore: "1h" })],
    ["signature_invalid", await credential({ key: "PRIVATE_SENTINEL_other_key" })],
    ["claims_invalid", await credential({ audience: "PRIVATE_SENTINEL_audience" })],
    ["claims_invalid", await credential({ issuer: "PRIVATE_SENTINEL_issuer" })],
    ["algorithm_rejected", await credential({ algorithm: "HS384" })],
    ["malformed", "PRIVATE_SENTINEL_not_a_jwt"],
    ["principal_missing", await credential({ claims: null })],
    ["principal_incomplete", await credential({ claims: { ownerUserId: principal.ownerUserId } })],
    ["signing_unconfigured", await credential(), {}],
  ];
  const reasons = new Set();
  for (const [reason, token, verificationEnv = env] of cases) {
    const replies = [];
    await sockets.answerOperation({ send: raw => replies.push(JSON.parse(raw)) }, "refresh", "Credential refresh failed",
      () => verifyMachineDaemonCredential(token, verificationEnv));
    await sendErrorReports();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].failure.code, "runtime.session_failed");
    assert.equal(replies[0].failure.retryable, false);
    assert.equal(replies[0].message, "Credential refresh failed");
    assert.doesNotMatch(JSON.stringify(replies), /PRIVATE_SENTINEL|machine_credential_reason/u);
    const events = exceptionEvents(envelopes);
    // Sentry may deduplicate adjacent failures with the same fixed reason.
    if (!reasons.has(reason)) assert.equal(events.length, reasons.size + 1);
    const latest = events.at(-1);
    assert.match(latest.exception.values[0].value, new RegExp(`\\(${reason}\\)$`, "u"));
    assert.equal(latest.extra.machine_credential_reason, reason);
    assert.deepEqual(latest.fingerprint, ["machine-daemon-credential", reason]);
    if (!reasons.has(reason)) assert.equal(latest.extra.diagnosticId, replies[0].failure.diagnosticId);
    const metadata = sentryEventMetadata({ tags: [{ key: "operation", value: latest.tags.operation }], context: latest.extra });
    assert.ok(metadata.includes(`Machine credential reason: ${reason}`));
    assert.ok(metadata.includes("Capture operation: runtime.machine-credential"));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL|eyJ/u);
    reasons.add(reason);
  }
  const valid = await signMachineDaemonCredential(env, principal);
  assert.equal((await verifyMachineDaemonCredential(valid, env)).machineId, principal.machineId);
  const mockEnv = { XMATRIX_MOCK_AUTH_TOKEN: "mock-signing-key" };
  const mockToken = await signMachineDaemonCredential(mockEnv, principal);
  assert.equal((await verifyMachineDaemonCredential(mockToken, mockEnv)).ownerUserId, principal.ownerUserId);
  await sendErrorReports();
  assert.equal(exceptionEvents(envelopes).length, reasons.size, "valid credentials add no failure reports");
  assert.deepEqual(sentryEventMetadata({ context: { machine_credential_reason: "PRIVATE_SENTINEL" } }), []);
});
