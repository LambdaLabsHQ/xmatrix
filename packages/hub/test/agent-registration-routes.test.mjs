import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  registerAgentRegistrationRoutes,
} from "../src/index-routes-agent-registration.ts";
import { ControlError, RegistrationAccessError } from "@xmatrix/db";
import { getAgentRegistration, refreshAgentRegistrationQuota } from "../src/agent-registrations.ts";
const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" };
const body = { action: "offer", key, commandId: "offer", displayName: "codex" };

function fixture(user = { id: "owner" }, environment = undefined, environmentFailure = undefined) {
  const calls = [], app = new Hono();
  const record = name => async (_env, input) => { calls.push({ name, input }); return { key }; };
  registerAgentRegistrationRoutes(app, { authenticate: async () => user,
    control: record("control"), get: record("get"), describe: record("describe"),
    changeEnvironment: record("changeEnvironment"),
    getEnvironment: environmentFailure ? async () => { throw environmentFailure; }
      : environment === undefined ? record("getEnvironment") : async () => ({ key, version: 1, environment }) });
  return { calls, request: (payload = body, action = "commands", physical = false) => app.request(
    `${physical ? "/api/agent-environments" : "/api/spaces/space/agent-registrations"}/${action}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, {}) };
}

test("registration HTTP commands bind the authenticated human and structured Space key", async () => {
  const route = fixture();
  const response = await route.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(route.calls, [{ name: "control", input: { actorUserId: "owner", command: body, byAgent: false } }]);
  assert.equal((await route.request(key, "query")).status, 200);
  assert.deepEqual(route.calls[1], { name: "get", input: { actorUserId: "owner", key } });
});

test("a harness description is free text, written by a person or by a Run as its owner in its own Space", async () => {
  const text = "擅长代码审计。\n\nKeep UI work away from it: {\"not\": \"a schema\"}";
  const route = fixture();
  assert.equal((await route.request({ harness: "codex", description: text, expectedRevision: 3 }, "profiles")).status, 200);
  assert.deepEqual(route.calls, [{ name: "describe", input: { actorUserId: "owner", spaceId: "space",
    command: { harness: "codex", description: text, expectedRevision: 3 } } }]);
  for (const payload of [{ harness: "codex" }, { harness: "codex", description: "x".repeat(1001) },
    { harness: "codex", description: "ok", ownerUserId: "someone" }, { harness: "custom", description: "ok" }]) {
    assert.equal((await route.request(payload, "profiles")).status, 400);
  }
  assert.equal(route.calls.length, 1);
  const run = { ownerUserId: "owner", spaceId: "space", machineId: "machine" };
  const agent = fixture({ id: "agent-run:run", agentRun: run });
  assert.equal((await agent.request({ harness: "codex", description: "" }, "profiles")).status, 200);
  assert.equal(agent.calls[0].input.actorUserId, "owner", "a Run has its owner's authority, no more");
  const elsewhere = fixture({ id: "agent-run:run", agentRun: { ...run, spaceId: "other" } });
  assert.equal((await elsewhere.request({ harness: "codex", description: "" }, "profiles")).status, 404);
  assert.equal(elsewhere.calls.length, 0);
});

test("physical environment endpoints are owned by the authenticated machine owner, not Space administration", async () => {
  const { spaceId: _spaceId, ...physicalKey } = key;
  const command = { key: physicalKey, commandId: "environment", expectedVersion: 0, expectedMachineVersion: 0,
    machineMaxConcurrent: 1, environment: { schemaVersion: 1, enabled: true, models: ["model"], description: "",
      availability: "interactive", maxConcurrent: 1, capabilities: [] } };
  const owner = fixture();
  assert.equal((await owner.request(command, "commands", true)).status, 200);
  assert.equal(owner.calls[0].name, "changeEnvironment");
  assert.equal(owner.calls[0].input.actorUserId, "owner");
  assert.equal((await owner.request(physicalKey, "query", true)).status, 200);
  const admin = fixture({ id: "space-admin" });
  assert.equal((await admin.request(command, "commands", true)).status, 404);
  assert.equal((await admin.request(physicalKey, "query", true)).status, 404);
  assert.equal(admin.calls.length, 0);
  assert.equal((await owner.request({ ...command, key }, "commands", true)).status, 400);
});

test("an Agent Run adds an Agent for its owner on its own Machine in its own Space, and nothing else", async () => {
  const run = { ownerUserId: "owner", spaceId: "space", machineId: "machine" };
  const create = { action: "create", key, commandId: "create", displayName: "codex", environment: {
    schemaVersion: 1, enabled: true, models: [], description: "", availability: "unknown", capabilities: [],
    launch: { runtime: "codex", runtimeArgs: [], sandboxMode: "off", requestReviewer: "low-risk-auto" } } };
  // What an Agent may do on a machine is its owner's to confirm. A Run adds
  // only a harness whose access its owner confirmed there, and the refusal
  // names what the owner runs.
  const unconfirmedAdd = { ...create, environment: { ...create.environment,
    launch: { runtime: "codex", runtimeArgs: [], access: "full" } } };
  for (const held of [null, { launch: { runtime: "codex", runtimeArgs: [] } }]) {
    const unconfirmed = fixture({ id: "agent-run:run", agentRun: run }, held);
    const refused = await unconfirmed.request(unconfirmedAdd);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /xmatrix agent add codex --space space/u);
    assert.equal(unconfirmed.calls.length, 0, "nothing is written, whatever mode the Run sent");
  }
  const neverAdded = fixture({ id: "agent-run:run", agentRun: run }, undefined,
    new RegistrationAccessError("registration_not_found", 404));
  const refusedNeverAdded = await neverAdded.request(unconfirmedAdd);
  assert.equal(refusedNeverAdded.status, 403, "a missing environment is an unconfirmed add, not a missing registration");
  assert.match((await refusedNeverAdded.json()).error, /xmatrix agent add codex --space space/u);
  assert.equal(neverAdded.calls.length, 0);
  const agent = fixture({ id: "agent-run:run", agentRun: run }, { launch: { runtime: "codex", runtimeArgs: [], access: "full" } });
  const added = await agent.request({ ...create, environment: { ...create.environment,
    launch: { runtime: "codex", runtimeArgs: [], access: "full" } } });
  assert.equal(added.status, 200, await added.clone().text());
  assert.deepEqual([agent.calls[0].input.actorUserId, agent.calls[0].input.byAgent], ["owner", true],
    "it acts as its owner, without an admin's creation exception");
  assert.equal(agent.calls[0].input.command.environment.launch.access, undefined, "a Run never writes a mode of its own");
  for (const [payload, why] of [[body, "only adding"], [{ ...create, key: { ...key, machineId: "other" } }, "only its Machine"],
    [{ ...create, key: { ...key, ownerUserId: "someone" } }, "only for its owner"]]) {
    assert.equal((await agent.request(payload)).status, 403, why);
  }
  assert.equal((await agent.request(key, "query")).status, 403, "registration queries stay with people");
  assert.equal(agent.calls.length, 1);
  const elsewhere = fixture({ id: "agent-run:run", agentRun: { ...run, spaceId: "other" } });
  assert.equal((await elsewhere.request(create)).status, 403, "only in its own Space");
});

test("a mode is confirmed only for a harness whose permission requests xMatrix can show", async () => {
  const create = harness => ({ action: "create", key: { ...key, harness }, commandId: "create", displayName: harness, environment: {
    schemaVersion: 1, enabled: true, models: [], description: "", availability: "unknown", capabilities: [],
    launch: { runtime: harness, runtimeArgs: [], access: "ask" } } });
  const owner = fixture();
  // Codex's approvals do not reach the bridge, so it is given full access or not added.
  const refused = await owner.request(create("codex"));
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /codex can only be given full access/u);
  assert.equal(owner.calls.length, 0);
  // DeepSeek Harness relays requests, but its full access is an environment
  // setting: left on its own sandbox it cannot run the xmatrix CLI at all.
  const sandboxed = await owner.request(create("deepseek"));
  assert.equal(sandboxed.status, 400);
  assert.match((await sandboxed.json()).error, /deepseek can only be given full access/u);
  assert.equal(owner.calls.length, 0);
  for (const harness of ["claude", "cursor", "grok"]) assert.equal((await owner.request(create(harness))).status, 200, harness);
  const { spaceId: _spaceId, ...physicalKey } = key;
  const change = { key: physicalKey, commandId: "environment", expectedVersion: 1, environment: create("codex").environment };
  assert.equal((await owner.request(change, "commands", true)).status, 400);
});

test("Agent Runs, spoofed principals, oversized input and cross-Space selections never reach authority", async () => {
  const agent = fixture({ id: "owner", agentRun: { ownerUserId: "owner", spaceId: "space", machineId: "machine" } });
  assert.equal((await agent.request()).status, 403);
  assert.equal(agent.calls.length, 0);
  const route = fixture();
  for (const [payload, status] of [[{ ...body, principal: { kind: "user", id: "admin" } }, 400],
    [{ ...body, key: { ...key, spaceId: "other" } }, 404],
    [{ ...body, displayName: "x".repeat(40_000) }, 413],
    [{ ...body, key: { ...key, profileId: "old-id" } }, 400]]) {
    assert.equal((await route.request(payload)).status, status);
  }
  assert.equal(route.calls.length, 0);
});

test("registration query resolves current placement and closes its request session", async () => {
  const contexts = [];
  let closed = 0;
  const database = { cacheMode: "disabled", openSession() { return { ...this, close: async () => { closed++; } }; },
    transaction: async (context, callback) => {
      contexts.push(context);
      return callback({ query: async ({ name }) => {
        if (name === "space_placement_resolve_v1") return [{ space_id: "space", shard_id: "shard-1",
          placement_epoch: 7, state: "active", target_shard_id: null, plan_class: "default" }];
        if (name === "registration_authority_active_v1") return [{ mode: "composite" }];
        if (name === "registration_get_visibility_v1") return [{}];
        if (name === "registration_control_member_v1") return [{ role: "member" }];
        if (name === "registration_control_get_v3") return [{ display_name: "codex", version: 1,
          configuration_json: { workspaceReferences: ["do-not-expose"] } }];
        assert.fail(name);
      } });
    } };
  const registration = await getAgentRegistration({}, { actorUserId: "member", key }, { database });
  assert.equal(registration.configuration, undefined);
  assert.equal(contexts[0].placement, undefined);
  assert.equal(contexts[1].placement.shardId, "shard-1");
  assert.equal(contexts[1].placement.placementEpoch, 7);
  assert.equal(closed, 1);
});

test("the Agents page catalog read asks for a quota refresh after answering; other reads do not", async () => {
  const calls = [], waited = [], app = new Hono();
  registerAgentRegistrationRoutes(app, { authenticate: async () => ({ id: "member" }),
    list: async () => ({ registrations: [], cursor: null }),
    refreshQuota: async (_env, input) => { calls.push(input); return { issued: 1 }; } });
  const read = path => app.request(path, {}, {}, { waitUntil: task => waited.push(task), passThroughOnException() {} });
  assert.equal((await read("/api/spaces/space/agent-registrations")).status, 200);
  assert.deepEqual(calls, []);
  assert.equal((await read("/api/spaces/space/agent-registrations?quota=refresh")).status, 200);
  await Promise.all(waited);
  assert.deepEqual(calls, [{ actorUserId: "member", spaceId: "space" }]);
});

function refreshDatabase({ role = "member", daemons }) {
  const seen = [];
  const database = { cacheMode: "disabled", openSession() { return { ...this, close: async () => {} }; },
    transaction: async (_context, callback) => callback({ query: async ({ name, values }) => {
      seen.push({ name, values });
      if (name === "space_placement_resolve_v1") return [{ space_id: "space", shard_id: "shard-1",
        placement_epoch: 7, state: "active", target_shard_id: null, plan_class: "default" }];
      if (name === "registration_control_member_v1") return role ? [{ role }] : [];
      if (name === "registration_quota_probe_registrations_v1") return [{ owner_user_id: "owner",
        machine_id: "machine", harness: "claude" }];
      if (name === "registration_quota_probe_daemons_v8") return daemons;
      assert.fail(name);
    } }) };
  return { database, seen };
}

const refresh = (actorUserId, database, quotaProbes) =>
  refreshAgentRegistrationQuota({}, { actorUserId, spaceId: "space" }, { database, quotaProbes });
const daemonRow = patch => ({ owner: "owner", machine: "machine", harness: "claude", environment_version: 3,
  quota_pool_id: "pool", hostname: "host", connection_epoch: 5, recently_probed: false, ...patch });
const quotaProbes = issued => ({
  machines: { getDaemon: async () => ({ daemon: { id: "daemon", email: "o@example.test", status: "online",
    capabilities: ["machine_quota_probe_v2"] } }) },
  issue: async (command) => { issued.push(command); return {}; } });

test("a Space member's quota refresh probes each daemon at most once a minute, asking for window names", async () => {
  const issued = [];
  const { database, seen } = refreshDatabase({ daemons: [daemonRow()] });
  assert.deepEqual(await refresh("member", database, quotaProbes(issued)), { issued: 1 });
  assert.equal(issued[0].payload.probe.windowLabels, true);
  assert.equal(issued[0].payload.probe.scopedQuotaUsages, true);
  assert.deepEqual(issued[0].payload.probe.targets.map(target => target.targetId), ["registration:claude"]);
  assert.equal(seen.find(query => query.name === "registration_quota_probe_daemons_v8").values[1], 60_000);

  const again = [];
  const recent = refreshDatabase({ daemons: [daemonRow({ recently_probed: true })] });
  assert.deepEqual(await refresh("member", recent.database, quotaProbes(again)), { issued: 0 });
  assert.equal(again.length, 0);

  // Two online hosts stay ambiguous even when one was just probed.
  const ambiguous = refreshDatabase({ daemons: [daemonRow({ recently_probed: true }), daemonRow({ hostname: "host-2" })] });
  assert.deepEqual(await refresh("member", ambiguous.database, quotaProbes(again)), { issued: 0 });
});

test("only a Space member may refresh its quota", async () => {
  const issued = [];
  const { database, seen } = refreshDatabase({ role: null, daemons: [daemonRow()] });
  await assert.rejects(refresh("outsider", database, quotaProbes(issued)),
    error => error instanceof ControlError && error.status >= 400 && error.status < 500);
  assert.equal(issued.length, 0);
  assert.equal(seen.some(query => query.name.startsWith("registration_quota_probe")), false);
});
