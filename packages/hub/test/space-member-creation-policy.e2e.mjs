import { acceptSpaceMembership } from "./support/space-membership.mjs";
import { bearerJsonRequest } from "./support/bearer-json-request.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { MOCK_TOKEN } from "./agent-mention-spawn.fixture.mjs";
import {
  channelSpaceId,
  createPgSpawnableScenario,
  launchScenarioRun,
  startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";
import { inWorkerTransaction } from "./registration-launch.fixture.mjs";

const OWNER_TOKEN = "space-creation-policy-owner-token";
const OWNER_USER_ID = "space-creation-policy-owner";
const ADMIN_TOKEN = "space-creation-policy-admin-token";
const ADMIN_USER_ID = "space-creation-policy-admin";
const MEMBER_TOKEN = "space-creation-policy-member-token";
const MEMBER_USER_ID = "space-creation-policy-member";

const MOCK_AUTH_USERS = JSON.stringify({
  [OWNER_TOKEN]: {
    id: OWNER_USER_ID,
    email: `${OWNER_USER_ID}@example.com`,
    name: "Creation Policy Owner",
  },
  [ADMIN_TOKEN]: {
    id: ADMIN_USER_ID,
    email: `${ADMIN_USER_ID}@example.com`,
    name: "Creation Policy Admin",
  },
  [MEMBER_TOKEN]: {
    id: MEMBER_USER_ID,
    email: `${MEMBER_USER_ID}@example.com`,
    name: "Creation Policy Member",
  },
});

/** Run a test body on its own PostgreSQL-backed Hub, stopped when it ends. */
async function withPolicyWorker(body) {
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_USERS: MOCK_AUTH_USERS } });
  try { await body(worker); } finally { await worker.stop(); }
}

async function requestJson(worker, token, path, init = {}) {
  return bearerJsonRequest(worker, token, path, init, { trimEmpty: true });
}

function addMember(worker, spaceId, token, role) {
  return acceptSpaceMembership(worker, requestJson, OWNER_TOKEN, token, spaceId, role);
}

/** A machine its owner has enrolled, as the daemon's first connection records it. */
async function enrollMachine(worker, ownerUserId) {
  const machineId = `machine:${ownerUserId}`;
  await inWorkerTransaction(worker, tx => tx.query({ text: `INSERT INTO data.machine_daemons
    (daemon_id,owner_user_id,owner_email,machine_id,hostname,status,capabilities_json,metadata_json,
     connection_epoch,version,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,'online','[]','{}',1,1,now(),now()) ON CONFLICT DO NOTHING`,
  values: [`daemon:${ownerUserId}`, ownerUserId, `${ownerUserId}@example.com`, machineId, `host:${ownerUserId}`] }));
  return machineId;
}

/** A Human adds an Agent on their own machine: one registration `create` command. */
function createAgent(worker, token, { spaceId, ownerUserId, machineId, harness, displayName = harness }) {
  return requestJson(worker, token, `/api/spaces/${encodeURIComponent(spaceId)}/agent-registrations/commands`, {
    method: "POST",
    body: JSON.stringify({
      action: "create",
      key: { spaceId, ownerUserId, machineId, harness },
      commandId: `create:${harness}:${Date.now()}:${Math.random()}`,
      displayName,
      environment: { schemaVersion: 1, enabled: true, models: [], description: "", availability: "interactive",
        maxConcurrent: 1, capabilities: [], launch: { runtime: harness } },
    }),
  });
}

function registrationRoute(spaceId, operation) {
  return `/api/spaces/${encodeURIComponent(spaceId)}/agent-registrations/${operation}`;
}

/** Change an existing Agent's Space configuration, optionally carrying extra fields. */
async function configureAgent(worker, token, key, configuration) {
  const current = await requestJson(worker, token, registrationRoute(key.spaceId, "query"), {
    method: "POST", body: JSON.stringify(key) });
  assert.equal(current.response.status, 200, JSON.stringify(current.payload));
  return requestJson(worker, token, registrationRoute(key.spaceId, "commands"), {
    method: "POST",
    body: JSON.stringify({
      action: "configure", key, commandId: `configure:${Math.random()}`, expectedVersion: current.payload.version,
      displayName: current.payload.displayName,
      configuration: { ...current.payload.configuration, ...configuration },
    }),
  });
}

/** An Automation is made on a page section (docs/design/pages-live-document.md §6). */
function createAutomation(worker, token, page, name) {
  return requestJson(worker, token, `/api/spaces/${encodeURIComponent(page.spaceId)}/pages/${
    encodeURIComponent(page.pageId)}/automations`, {
    method: "POST",
    body: JSON.stringify({ name, instruction: `${name} message`, intervalMinutes: 60 }),
  });
}

async function createPage(worker, token, spaceId) {
  const created = await requestJson(worker, token, `/api/spaces/${encodeURIComponent(spaceId)}/pages`, {
    method: "POST", body: JSON.stringify({ title: "Schedules", body: "# Schedules\n" }) });
  assert.equal(created.response.status, 200, JSON.stringify(created.payload));
  return { spaceId, pageId: created.payload.page.pageId };
}

test("Space member creation policies default open and restrict every new Human creation path", () => withPolicyWorker(async (worker) => {
  const createdSpace = await requestJson(worker, OWNER_TOKEN, "/api/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Space member creation policy" }),
  });
  assert.equal(createdSpace.response.status, 200, JSON.stringify(createdSpace.payload));
  const spaceId = createdSpace.payload.space.id;
  assert.deepEqual(createdSpace.payload.space.memberPermissions, {
    agentCreation: "members",
    automationCreation: "members",
  });
  await addMember(worker, spaceId, ADMIN_TOKEN, "admin");
  await addMember(worker, spaceId, MEMBER_TOKEN, "member");
  const memberMachine = await enrollMachine(worker, MEMBER_USER_ID);
  const adminMachine = await enrollMachine(worker, ADMIN_USER_ID);

  const page = await createPage(worker, OWNER_TOKEN, spaceId);

  const memberAgent = { spaceId, ownerUserId: MEMBER_USER_ID, machineId: memberMachine, harness: "codex" };
  const existingAgent = await createAgent(worker, MEMBER_TOKEN, { ...memberAgent, displayName: "existing-member-agent" });
  assert.equal(existingAgent.response.status, 200, JSON.stringify(existingAgent.payload));
  // Only the machine's owner adds an Agent on it, whatever their Space role.
  const foreignMachine = await createAgent(worker, OWNER_TOKEN, { ...memberAgent, harness: "claude" });
  assert.equal(foreignMachine.response.status, 403, JSON.stringify(foreignMachine.payload));
  assert.equal(foreignMachine.payload.code, "registration_owner_required");

  const existingAutomation = await createAutomation(
    worker,
    MEMBER_TOKEN,
    page,
    "Existing member Automation",
  );
  assert.equal(existingAutomation.response.status, 201, JSON.stringify(existingAutomation.payload));

  const restricted = await requestJson(
    worker,
    OWNER_TOKEN,
    `/api/spaces/${encodeURIComponent(spaceId)}/member-permissions`,
    {
      method: "PATCH",
      body: JSON.stringify({
        agentCreation: "admins",
        automationCreation: "admins",
      }),
    },
  );
  assert.equal(restricted.response.status, 200, JSON.stringify(restricted.payload));
  assert.deepEqual(restricted.payload.space.memberPermissions, {
    agentCreation: "admins",
    automationCreation: "admins",
  });

  const metadataUpdate = await requestJson(
    worker,
    OWNER_TOKEN,
    `/api/spaces/${encodeURIComponent(spaceId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        metadata: {
          memberPermissions: {
            agentCreation: "members",
            automationCreation: "members",
          },
        },
      }),
    },
  );
  assert.equal(metadataUpdate.response.status, 200, JSON.stringify(metadataUpdate.payload));
  assert.deepEqual(metadataUpdate.payload.space.memberPermissions, {
    agentCreation: "admins",
    automationCreation: "admins",
  });

  const memberAgentDenied = await createAgent(worker, MEMBER_TOKEN, { ...memberAgent, harness: "claude" });
  assert.equal(memberAgentDenied.response.status, 403, JSON.stringify(memberAgentDenied.payload));
  assert.equal(memberAgentDenied.payload.code, "registration_creation_restricted");

  const adminAgent = await createAgent(worker, ADMIN_TOKEN,
    { spaceId, ownerUserId: ADMIN_USER_ID, machineId: adminMachine, harness: "codex", displayName: "admin-agent" });
  assert.equal(adminAgent.response.status, 200, JSON.stringify(adminAgent.payload));

  // A Space owner or admin configures an existing Agent; a member cannot,
  // even their own Agent.
  const memberConfigure = await configureAgent(worker, MEMBER_TOKEN, memberAgent, { instructions: "Be brief." });
  assert.equal(memberConfigure.response.status, 403, JSON.stringify(memberConfigure.payload));
  assert.equal(memberConfigure.payload.code, "space_policy_authority_required");
  // The Agent Role is retired: a configuration still naming one (an older
  // client) saves without it, and the registration reports no Role.
  const retiredRole = { roleId: "role:retired:1", roleVersion: "1.0.0", roleDigest: `sha256:${"a".repeat(64)}` };
  const configured = await configureAgent(worker, ADMIN_TOKEN, memberAgent, { instructions: "Be brief.", role: retiredRole });
  assert.equal(configured.response.status, 200, JSON.stringify(configured.payload));
  const afterConfigure = await requestJson(worker, ADMIN_TOKEN, registrationRoute(spaceId, "query"), {
    method: "POST", body: JSON.stringify(memberAgent) });
  assert.equal(afterConfigure.payload.role, undefined);
  assert.equal(afterConfigure.payload.configuration.instructions, "Be brief.");
  assert.equal(Object.hasOwn(afterConfigure.payload.configuration, "role"), false);
  const retiredRoutes = await worker.fetch("/api/roles", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  assert.equal(retiredRoutes.status, 404, "the Role package routes are retired");

  const memberAutomationDenied = await createAutomation(
    worker,
    MEMBER_TOKEN,
    page,
    "Blocked member Automation",
  );
  assert.equal(memberAutomationDenied.response.status, 403, JSON.stringify(memberAutomationDenied.payload));
  assert.equal(memberAutomationDenied.payload.code, "space_member_automation_creation_disabled");

  const adminAutomation = await createAutomation(
    worker,
    ADMIN_TOKEN,
    page,
    "Admin Automation",
  );
  assert.equal(adminAutomation.response.status, 201, JSON.stringify(adminAutomation.payload));

  const existingAutomationUpdate = await requestJson(
    worker,
    MEMBER_TOKEN,
    `/api/automations/${encodeURIComponent(existingAutomation.payload.automation.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: existingAutomation.payload.automation.version,
        name: "Existing member Automation updated",
      }),
    },
  );
  assert.equal(
    existingAutomationUpdate.response.status,
    200,
    JSON.stringify(existingAutomationUpdate.payload),
  );

  const agents = await requestJson(worker, MEMBER_TOKEN, `/api/spaces/${encodeURIComponent(spaceId)}/agent-registrations`);
  assert.equal(agents.response.status, 200, JSON.stringify(agents.payload));
  const existing = agents.payload.registrations.find((registration) => registration.displayName === "existing-member-agent");
  assert.ok(existing, "the existing member Agent remains after creation is restricted");
  // The catalog reads where it stands against the migrated schema; nothing runs yet.
  assert.equal(typeof existing.live.machine.online, "boolean");
  assert.deepEqual(existing.live.running, []);
}));

test("only Space admins may update creation policies", () => withPolicyWorker(async (worker) => {
  const createdSpace = await requestJson(worker, OWNER_TOKEN, "/api/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Creation policy admin boundary" }),
  });
  const spaceId = createdSpace.payload.space.id;
  await addMember(worker, spaceId, MEMBER_TOKEN, "member");

  const denied = await requestJson(
    worker,
    MEMBER_TOKEN,
    `/api/spaces/${encodeURIComponent(spaceId)}/member-permissions`,
    {
      method: "PATCH",
      body: JSON.stringify({ agentCreation: "admins" }),
    },
  );
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));

  const unchanged = await requestJson(
    worker,
    MEMBER_TOKEN,
    `/api/spaces/${encodeURIComponent(spaceId)}`,
  );
  assert.deepEqual(unchanged.payload.space.memberPermissions, {
    agentCreation: "members",
    automationCreation: "members",
  });
}));

test("Agent principals never inherit the Human admin creation exception", async () => {
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: "space-creation-policy-agent-owner",
      XMATRIX_MOCK_AUTH_EMAIL: "space-creation-policy-agent-owner@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Creation Policy Agent Owner",
    },
  });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "creation-policy-agent-principal" });
    ({ daemon } = scenario);
    const { channelId } = scenario;
    const spaceId = await channelSpaceId(channelId);
    const restricted = await requestJson(
      worker,
      MOCK_TOKEN,
      `/api/spaces/${encodeURIComponent(spaceId)}/member-permissions`,
      {
        method: "PATCH",
        body: JSON.stringify({
          agentCreation: "admins",
          automationCreation: "admins",
        }),
      },
    );
    assert.equal(restricted.response.status, 200, JSON.stringify(restricted.payload));

    // This test exercises the signed Agent principal's authorization: a
    // registered Run launched and admitted the way the daemon admits it.
    const { token: runToken } = await launchScenarioRun(worker, scenario);

    const page = await createPage(worker, MOCK_TOKEN, spaceId);
    const automationDenied = await createAutomation(worker, runToken, page, "Agent-made Automation");
    assert.equal(automationDenied.response.status, 403, JSON.stringify(automationDenied.payload));
    assert.equal(
      automationDenied.payload.code,
      "space_member_automation_creation_disabled",
    );

    // A Run adds an Agent for its owner only as a member may: the owner's admin
    // exception to "admins only" never passes to it.
    const runAgent = { spaceId, ownerUserId: scenario.registration.ownerUserId,
      machineId: scenario.registration.machineId, harness: "claude" };
    const agentDenied = await createAgent(worker, runToken, runAgent);
    assert.equal(agentDenied.response.status, 403, JSON.stringify(agentDenied.payload));
    const reopened = await requestJson(worker, MOCK_TOKEN,
      `/api/spaces/${encodeURIComponent(spaceId)}/member-permissions`,
      { method: "PATCH", body: JSON.stringify({ agentCreation: "members" }) });
    assert.equal(reopened.response.status, 200, JSON.stringify(reopened.payload));
    const agentAdded = await createAgent(worker, runToken, runAgent);
    assert.equal(agentAdded.response.status, 200, JSON.stringify(agentAdded.payload));
  } finally {
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});
