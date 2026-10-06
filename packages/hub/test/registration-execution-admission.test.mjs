import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeRegistrationExecution,
} from "../src/registration-execution-admission.ts";
import { registrationExecutionPhase } from "../src/machine-daemon-agent-run-authorization.ts";
const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" };
const input = { env: {}, principal: { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "machine", hostId: "host" },
  runId: "run", spaceId: "space", phase: "admission", confirmedLease: { daemonId: "daemon", connectionEpoch: 2 },
  admission: { key, allocationId: "allocation", authorizationDigest: "a".repeat(64) } };

test("repository admission binds the authorized Run without requiring a local Workspace row", async () => {
  const calls = [];
  const resources = { workspaces: ["repo:owner/project"], models: ["model"], secrets: [], capabilities: [] };
  const binding = { schemaVersion: 1, key, runId: "run", instanceId: "instance", allocationId: "allocation",
    authorizationDigest: "a".repeat(64), environmentVersion: 1, runtimeModel: "model", resources };
  const request = { ...input, instanceId: "instance", workspaceCwd: ".xmatrix-management/registration-test",
    workspaceRepository: "owner/project", admission: { ...input.admission, resources }, claimedBinding: binding };
  const directoryDatabase = { cacheMode: "disabled", transaction: async (_context, callback) => callback({ query: async query => {
    calls.push(query);
    if (query.name === "registration_allocation_machine_lock_v2" || query.name === "registration_allocation_terminal_collect_v1") return [];
    if (query.name === "registration_allocation_clock_v1") return [{ authority_now: new Date().toISOString() }];
    if (query.name === "registration_allocation_daemon_v2") return [{ status: "online", connection_epoch: 2 }];
    if (query.name === "registration_allocation_exact_v2") {
      assert.deepEqual(query.values, ["allocation", "run", "space", "owner", "machine", "codex"]);
      return [{ state: "admitted", daemon_id: "daemon", connection_epoch: 2, authorization_digest: binding.authorizationDigest,
        environment_version: 1, runtime_model: "model" }];
    }
    if (query.name === "registration_allocation_workspace_v2") return query.values[0] === "workspace" ? [{}] : [];
    throw new Error(`Unexpected query ${query.name}`);
  } }) };
  for (const workspaceRepository of [undefined, "other/project"]) {
    const denied = await authorizeRegistrationExecution({ ...request, workspaceRepository }, { directoryDatabase });
    assert.equal((await denied.json()).code, "registration_repository_binding_mismatch");
  }
  assert.equal(calls.length, 0);
  assert.equal(await authorizeRegistrationExecution(request, { directoryDatabase }), undefined);
  assert.ok(calls.some(query => query.name === "registration_allocation_exact_v2"));
  assert.ok(!calls.some(query => query.name === "registration_allocation_workspace_v2"));
  const directoryResources = { ...resources, workspaces: ["workspace"] };
  assert.equal(await authorizeRegistrationExecution({ ...request, workspaceRepository: undefined,
    admission: { ...input.admission, resources: directoryResources },
    claimedBinding: { ...binding, resources: directoryResources } }, { directoryDatabase }), undefined);
  assert.deepEqual(calls.find(query => query.name === "registration_allocation_workspace_v2").values,
    ["workspace", "owner", "machine", request.workspaceCwd]);
});

test("registered startup requires a server-confirmed lease and exact owner/machine/Space", async () => {
  const directoryDatabase = { cacheMode: "disabled", transaction: () => { throw new Error("must not reach resource authority"); } };
  for (const [patch, code] of [
    [{ confirmedLease: undefined }, "registration_startup_admission_required"],
    [{ confirmedLease: { daemonId: "daemon", connectionEpoch: 0 } }, "registration_startup_admission_required"],
    [{ spaceId: "other" }, "registration_machine_mismatch"],
    [{ principal: { ...input.principal, machineId: "other" } }, "registration_machine_mismatch"],
    [{ admission: { ...input.admission, key: { ...key, ownerUserId: "other" } } }, "registration_machine_mismatch"],
    [{ admission: { ...input.admission, authorized: true } }, "registration_admission_invalid"],
    [{ admission: null }, "registration_admission_invalid"],
  ]) {
    const response = await authorizeRegistrationExecution({ ...input, ...patch }, { directoryDatabase });
    assert.equal((await response.json()).code, code);
  }
  // A Run without a registration admission never executes; there is no legacy pass.
  const unbound = await authorizeRegistrationExecution({ ...input, admission: undefined }, { directoryDatabase });
  assert.equal(unbound.status, 403);
  assert.equal((await unbound.json()).code, "registration_run_admission_missing");
});

test("token renewal reads global allocation and refuses cancellation without making another reservation", async () => {
  let state = "admitted";
  const names = [];
  const directoryDatabase = { cacheMode: "disabled", transaction: async (context, callback) => {
    assert.equal(context.placement, undefined);
    return callback({ query: async query => {
      names.push(query.name);
      if (query.name === "registration_allocation_machine_lock_v2") return [{}];
      if (query.name === "registration_allocation_clock_v1") return [{ authority_now: new Date().toISOString() }];
      if (query.name === "registration_allocation_terminal_collect_v1") return [];
      if (query.name === "registration_allocation_exact_v2") {
        assert.deepEqual(query.values, ["allocation", "run", "space", "owner", "machine", "codex"]);
        return [{ state, authorization_digest: "a".repeat(64), daemon_id: "daemon", allocation_id: "allocation",
          run_id: "run", generation: 1, runtime_model: "model", environment_version: 1 }];
      }
      if (query.name === "registration_allocation_continuation_host_v2") {
        assert.deepEqual(query.values, ["daemon", "owner", "machine"]); return [{ daemon_id: "daemon" }];
      }
      if (query.name === "registration_allocation_continuation_environment_v1") {
        assert.deepEqual(query.values, ["owner", "machine", "codex"]); return enabled ? [{}] : [];
      }
      if (query.name === "registration_allocation_machine_retired_v1") {
        assert.deepEqual(query.values, ["owner", "machine"]); return retired ? [{}] : [];
      }
      throw new Error(`unexpected query ${query.name}`);
    } });
  } };
  let enabled = true, retired = false;
  assert.equal(await authorizeRegistrationExecution({ ...input, phase: "continuation", confirmedLease: undefined }, { directoryDatabase }), undefined);
  // An owner who removed the Machine withdraws renewal too.
  retired = true;
  const removed = await authorizeRegistrationExecution({ ...input, phase: "continuation" }, { directoryDatabase });
  assert.equal(removed.status, 409);
  assert.equal((await removed.json()).code, "registration_machine_retired");
  retired = false;
  // An owner who disabled the Agent on its machine withdraws renewal too.
  enabled = false;
  const disabled = await authorizeRegistrationExecution({ ...input, phase: "continuation" }, { directoryDatabase });
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json()).code, "registration_environment_disabled");
  enabled = true;
  state = "stopping";
  const denied = await authorizeRegistrationExecution({ ...input, phase: "continuation" }, { directoryDatabase });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "allocation_not_admitted");
  assert.ok(!names.some(name => /reserve|admit_v1/u.test(name)));
});


test("canonical startup rejects missing, broadened or retargeted launch bindings before capacity admission", async () => {
  const resources = { workspaces: ["workspace"], models: ["model"], capabilities: ["approved"], maxConcurrent: 1 };
  const claimedBinding = { schemaVersion: 1, key, runId: "run", instanceId: "instance", allocationId: "allocation",
    authorizationDigest: "a".repeat(64), environmentVersion: 1, runtimeModel: "provider/model", resources };
  const directoryDatabase = { cacheMode: "disabled", transaction: () => { throw new Error("must not consume capacity"); } };
  for (const patch of [undefined, { ...claimedBinding, key: { ...key, spaceId: "other" } },
    { ...claimedBinding, key: { ...key, harness: "claude" } }, { ...claimedBinding, runId: "other" },
    { ...claimedBinding, instanceId: "other" }, { ...claimedBinding, allocationId: "other" },
    { ...claimedBinding, authorizationDigest: "b".repeat(64) },
    { ...claimedBinding, resources: { ...resources, capabilities: ["unapproved"] } }, { ...claimedBinding, runtime: "injected" }]) {
    const response = await authorizeRegistrationExecution({ ...input, instanceId: "instance",
      admission: { ...input.admission, resources }, claimedBinding: patch }, { directoryDatabase });
    assert.equal((await response.json()).code, "registration_launch_binding_mismatch");
  }
  const unadmitted = await authorizeRegistrationExecution({ ...input, admission: undefined, claimedBinding }, { directoryDatabase });
  assert.equal((await unadmitted.json()).code, "registration_run_admission_missing");
});

test("only the lease-renewing command admission admits a starting Run; a wrapper token is a continuation", () => {
  const lease = { daemonId: "daemon", connectionEpoch: 2 };
  assert.equal(registrationExecutionPhase("starting", lease), "admission");
  // The daemon mints its wrapper's token without a lease while the Run may
  // still be starting; demanding admission there refused every such launch.
  assert.equal(registrationExecutionPhase("starting", undefined), "continuation");
  assert.equal(registrationExecutionPhase("running", lease), "continuation");
  assert.equal(registrationExecutionPhase("running", undefined), "continuation");
});
