import assert from "node:assert/strict";
import test from "node:test";
import { requireRunRegistrationAccess } from "../dist/agent-registration-run.js";
import { registeredRunRows } from "./registered-run.fixture.mjs";

function access(respond, queries = []) {
  const tx = { query: async query => { queries.push(query.name); return respond(query) ?? []; } };
  return requireRunRegistrationAccess(tx, { runId: "run-1", channelId: "channel-1", phase: "continuation",
    error: (code, status) => Object.assign(new Error(code), { code, status }) });
}

test("a Run without a registration binding has no execution authority", async () => {
  await assert.rejects(() => access(() => undefined),
    error => error.code === "registration_run_admission_missing" && error.status === 403);
});

test("a bound Run is admitted under its registration's current grant and policy", async () => {
  const queries = [];
  const admission = await access(query => registeredRunRows(query), queries);
  assert.deepEqual(admission.key, { spaceId: "space-1", ownerUserId: "owner-1", machineId: "machine-1", harness: "codex" });
  assert.deepEqual(queries.slice(0, 1), ["run_registration_access_binding_v3"]);
  assert.ok(queries.includes("registration_admission_access_v1"), queries.join(","));
});

test("a revoked owner grant stops a bound Run", async () => {
  await assert.rejects(() => access(query => query.name === "registration_admission_access_v1"
    ? registeredRunRows(query).map(row => ({ ...row, grant_state: "revoked", grant_revision: 2, grant_execution_revision: 2 }))
    : registeredRunRows(query)), error => error.status === 403);
});
