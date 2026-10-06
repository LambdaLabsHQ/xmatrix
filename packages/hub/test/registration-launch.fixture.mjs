// Space Agent Registration fixtures shared by every Hub e2e that runs an Agent.
//
// A Run exists only as a Run of a registration (owner × machine × harness), so
// a test Agent is made the way its owner makes one — offer, machine
// environment, owner grant, Space policy, configuration naming a directory —
// and launched by a tagged `@auto` mention through the PostgreSQL launch
// authority. There is no Profile, and no other way to obtain a Run.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { Client } from "pg";

export { githubAppPrivateKey } from "./support/github-app.mjs";

/** Daemon capabilities of a CLI that runs registered and managed-directory launches. */
export const REGISTERED_DAEMON_CAPABILITIES = ["agent:spawn_in_workspace", "pty:headless",
  "registration_launch_v2", "registration_launch_v3", "registration_model_default_v1", "registration_optional_model_v1", "registration_managed_v1"];

async function json(response) {
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`${response.status}: ${text}`), { status: response.status });
  return text ? JSON.parse(text) : {};
}

function postgresUrl(worker) {
  if (!worker.postgresUrl) {
    throw new Error("Agent Runs launch only through a Space Agent Registration; start the Hub with startPgHubWorker");
  }
  return worker.postgresUrl;
}

/** One transaction on the worker's database, shaped like the authority's. */
export function inWorkerTransaction(worker, body) {
  return inPostgresTransaction(postgresUrl(worker), body);
}

/** One transaction on a PostgreSQL database, shaped like the authority's. */
export async function inPostgresTransaction(connectionString, body) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    const result = await body({ query: async query => (await client.query(query.text, query.values)).rows });
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { await client.end(); }
}

/** The authenticated Human's id, as the Hub knows it. */
export async function authenticatedUserId(worker, token) {
  const me = await json(await worker.fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } }));
  const id = me.user?.id ?? me.id;
  if (typeof id !== "string" || !id) throw new Error("the test Human has no id");
  return id;
}

/** The Space a Channel belongs to. */
export async function spaceOfChannel(worker, channelId) {
  const rows = await inWorkerTransaction(worker, tx => tx.query({
    text: "SELECT space_id FROM data.channels WHERE channel_id=$1", values: [channelId] }));
  if (!rows[0]) throw new Error(`no Channel ${channelId}`);
  return rows[0].space_id;
}

/**
 * Register a harness the way its owner does: the Space registration (its
 * offer enrolls the tuple), the machine's physical environment, the owner's
 * grant and the Space's policy, and a configuration naming the registered
 * directory. Returns the Space registration key.
 */
export async function registerTestAgent(worker, { token, spaceAdminToken = token, spaceId, ownerUserId, machineId,
  harness = "codex", displayName = harness, canonicalCwd, capabilities = [],
  launch = { runtime: harness, backend: "codex-app", runtimeArgs: [] } }) {
  ownerUserId ??= await authenticatedUserId(worker, token);
  const physical = { ownerUserId, machineId, harness };
  const key = { spaceId, ...physical };
  const command = async (route, body, actorToken = token) => {
    const response = await worker.fetch(route, { method: "POST",
      headers: { Authorization: `Bearer ${actorToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${body.action ?? "environment"} ${route} ${response.status}: ${await response.text()}`);
    return response.json();
  };
  const workspaces = canonicalCwd === undefined ? [] : (await inWorkerTransaction(worker, tx => tx.query({
    text: "SELECT workspace_id FROM data.workspaces WHERE owner_user_id=$1 AND machine_id=$2 AND canonical_cwd=$3",
    values: [ownerUserId, machineId, canonicalCwd] }))).map(row => String(row.workspace_id));
  if (canonicalCwd !== undefined && workspaces.length !== 1) throw new Error(`no Workspace ${canonicalCwd} on ${machineId}`);
  const spaceRoute = `/api/spaces/${encodeURIComponent(spaceId)}/agent-registrations/commands`;
  const offered = await command(spaceRoute, { action: "offer", key, commandId: `offer:${randomUUID()}`, displayName });
  await command("/api/agent-environments/commands", { key: physical, commandId: `env:${randomUUID()}`,
    expectedVersion: 0, environment: { schemaVersion: 1, enabled: true, models: [], description: "",
      availability: "unattended", maxConcurrent: 1, launch,
      capabilities: capabilities.map(capability => ({ key: capability, description: capability,
        expiresAt: "2099-01-01T00:00:00.000Z" })) } });
  const limits = { workspaces, models: [], capabilities };
  await command(spaceRoute, { action: "owner-grant", key, commandId: `grant:${randomUUID()}`, state: "active",
    expectedRevision: 1, limits });
  // The Space's configuration is its owner's or an admin's to set.
  await command(spaceRoute, { action: "configure", key, commandId: `configure:${randomUUID()}`, displayName,
    expectedVersion: offered.version, configuration: { workspaceReferences: limits.workspaces } },
  spaceAdminToken);
  return key;
}

/** Admit a registered spawn the way the daemon does; returns the Run credential. */
export async function admitRegisteredSpawn(worker, daemon, command) {
  const response = await worker.fetch("/api/daemon/command-admit-authorize", {
    method: "POST", headers: { Authorization: `Bearer ${daemon.machineCredential ?? daemon.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: command.requestId, admittedAt: new Date().toISOString(), launchId: command.launchId,
      runId: command.runId, instanceId: command.instanceId, executionKey: command.executionKey, agentId: command.identityId,
      spaceId: command.spaceId, channelId: command.channelId, workspace: command.workspace,
      managementSpaceId: command.managementSpaceId, remoteRepo: command.remoteRepo,
      relayLease: command.relayLease, registration: command.registration }),
  });
  const admitted = await response.json();
  if (admitted.ok !== true || typeof admitted.token !== "string") {
    throw new Error(`registered spawn admission failed: ${JSON.stringify(admitted)}`);
  }
  return admitted.token;
}

const registrationsByWorker = new WeakMap();

/**
 * Launch one Run of a registered harness in a Channel: register the harness
 * on the daemon's machine with its own directory (once per worker, Space,
 * machine and harness), mention it with a tagged `@auto` launch, and admit the
 * spawn the daemon receives. Returns the spawn command, the Run credential and
 * the registration key.
 */
export async function launchRegisteredRun(worker, { token, spaceAdminToken = token, daemon, channelId, machineId,
  harness = "codex", displayName = harness, prompt = "Start test Agent Run.", launch }) {
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const spaceId = await spaceOfChannel(worker, channelId);
  let registrations = registrationsByWorker.get(worker);
  if (!registrations) registrationsByWorker.set(worker, registrations = new Map());
  const cacheKey = JSON.stringify([spaceId, machineId, harness]);
  let registered = registrations.get(cacheKey);
  if (!registered) {
    registered = (async () => {
      const canonicalCwd = `/tmp/xmatrix-e2e-${randomUUID()}`;
      const hostId = daemon.hostId ?? machineId.replace(/^machine:/u, "");
      await json(await worker.fetch("/api/workspaces", { method: "POST", headers,
        body: JSON.stringify({ machineId, hostId, hostName: hostId, canonicalCwd, displayName, runtime: harness }) }));
      const key = await registerTestAgent(worker, { token, spaceAdminToken, spaceId, machineId, harness, displayName, canonicalCwd,
        ...(launch ? { launch } : {}) });
      return { key, canonicalCwd };
    })();
    registrations.set(cacheKey, registered);
  }
  const { key, canonicalCwd } = await registered;
  const spawn = daemon.inbox.waitFor(message => message.type === "machine_spawn_agent" &&
    message.channelId === channelId && message.registration?.key?.machineId === machineId &&
    message.registration?.key?.harness === harness, `registered spawn of ${displayName}`);
  await json(await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, { method: "POST", headers,
    body: JSON.stringify({ body: `@auto harness:${harness} machine:${machineId} pwd:"${canonicalCwd}" ${prompt}` }) }));
  const command = await spawn;
  return { command, key, canonicalCwd, token: await admitRegisteredSpawn(worker, daemon, command) };
}

/** Whether a daemon message spawns a Run of the given registration. */
export function isSpawnOf(message, key) {
  const spawned = message.registration?.key;
  return message.type === "machine_spawn_agent" && spawned?.spaceId === key.spaceId &&
    spawned.ownerUserId === key.ownerUserId && spawned.machineId === key.machineId && spawned.harness === key.harness;
}

/** A GitHub API stand-in that answers one App installation's repository catalog. */
export function githubInstallationCatalog(id, repositories) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.includes(`/app/installations/${id}/access_tokens`)) {
        response.end(JSON.stringify({ token: "ghs_fixture", expires_at: "2026-09-25T00:00:00Z", permissions: { metadata: "read" } }));
        return;
      }
      if (request.url?.includes("/installation/repositories")) {
        response.end(JSON.stringify({ repositories, total_count: repositories.length }));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("github catalog did not bind")); return; }
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise(done => server.close(() => done())) });
    });
  });
}

/** Connect a Space to one GitHub App installation, as the user who installed it. */
export function connectGitHubInstallation(worker, { spaceId, userId, installationId }) {
  return inWorkerTransaction(worker, tx => tx.query({ text: `INSERT INTO data.app_connector_connections
    (connection_id,space_id,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,capabilities_json,
     channel_ids_json,created_by,metadata_json,search_rank_sequence,version,created_at,updated_at)
    VALUES ($1,$2,'github','GitHub','configured','oauth','[]','[]','[]','[]',$3,$4::jsonb,$5,1,now(),now())
    ON CONFLICT DO NOTHING`,
  values: [`${spaceId}:github`, spaceId, userId, JSON.stringify({ installationIds: [installationId] }), randomUUID()] }));
}

/**
 * Connect the Space's GitHub installation and grant a registration one of its
 * repositories: the owner's grant, the Space's policy and the configuration
 * each name `repo:<owner/name>`, exactly as their owners would.
 */
export async function grantRegistrationRepository(worker, { token, key, repository, installationId }) {
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  await connectGitHubInstallation(worker, { spaceId: key.spaceId, userId: key.ownerUserId, installationId });
  const details = await json(await worker.fetch(`/api/spaces/${encodeURIComponent(key.spaceId)}/agent-registrations/query`, {
    method: "POST", headers, body: JSON.stringify(key) }));
  const workspaces = [...new Set([...details.access.grant.limits.workspaces, `repo:${repository}`])].sort();
  const limits = { ...details.access.grant.limits, workspaces };
  const route = `/api/spaces/${encodeURIComponent(key.spaceId)}/agent-registrations/commands`;
  for (const body of [
    { action: "owner-grant", key, commandId: `grant:${randomUUID()}`, state: "active",
      expectedRevision: details.access.grant.revision, limits },
    { action: "configure", key, commandId: `configure:${randomUUID()}`, displayName: details.displayName,
      expectedVersion: details.version, configuration: { ...details.configuration, workspaceReferences: workspaces } },
  ]) {
    await json(await worker.fetch(route, { method: "POST", headers, body: JSON.stringify(body) }));
  }
}
