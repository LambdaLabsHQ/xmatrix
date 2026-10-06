// PostgreSQL-backed lifecycle launch fixture.
//
// After the :new/:once retirement, a lifecycle mention must use the tagged
// `@auto` grammar, which routes through the PostgreSQL routing/launch
// authorities. This fixture starts the scoped test worker with those
// authorities on PostgreSQL with the same legacy fact-materialization fences
// production uses, plus a controlled local Jev decision
// model, so lifecycle tests cross the real authorized launch path instead of
// the removed suffix grammar.
//
// There is no non-PostgreSQL fallback: without XMATRIX_TEST_POSTGRES_URL the
// fixture throws instead of skipping, so a missing database can never look
// like a pass.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MOCK_TOKEN,
  connectAgent,
  json,
  postChannelMessage,
  randomUUID,
  runAgentConnection,
  startHubWorker,
} from "./agent-mention-spawn.fixture.mjs";

import { Client } from "pg";
import {
  REGISTERED_DAEMON_CAPABILITIES,
  admitRegisteredSpawn,
  authenticatedUserId,
  inPostgresTransaction,
  isSpawnOf,
  registerTestAgent,
} from "./registration-launch.fixture.mjs";

export { REGISTERED_DAEMON_CAPABILITIES, admitRegisteredSpawn, isSpawnOf, registerTestAgent };

/** The authenticated Human's id, as the Hub knows it. */
export function testUserId(worker, token = MOCK_TOKEN) {
  return authenticatedUserId(worker, token);
}

const hubDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sharedTestPostgresUrl() {
  const url = process.env.XMATRIX_TEST_POSTGRES_URL?.trim();
  if (!url) {
    throw new Error(
      "agent-launch-postgres fixture requires XMATRIX_TEST_POSTGRES_URL; the tagged launch authority is PostgreSQL-only and must not be skipped",
    );
  }
  return url;
}

/** The running PostgreSQL worker's own database (test files start one worker at a time). */
let workerDatabaseUrl;

/** The database the running PostgreSQL worker, and every helper beside it, reads and writes. */
export function testPostgresUrl() {
  return workerDatabaseUrl ?? sharedTestPostgresUrl();
}

function databaseIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(name)) throw new Error(`Unsupported test database name: ${name}`);
  return `"${name}"`;
}

async function onMaintenanceDatabase(body) {
  const url = new URL(sharedTestPostgresUrl());
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try { return await body(client); } finally { await client.end(); }
}

/**
 * Each worker gets a private database cloned from the migrated test template.
 *
 * The Agent Launch coordinator (like every PostgreSQL sweep) is a singleton
 * that owns every eligible row in its database. Workers sharing one database
 * therefore claim each other's fresh Launches; the claimant cannot reach the
 * owner's daemon socket, settles the Launch daemon-offline and defers it 30s,
 * and the owning test times out waiting for its spawn.
 */
async function createTestWorkerDatabase() {
  const shared = new URL(sharedTestPostgresUrl());
  const template = process.env.XMATRIX_TEST_POSTGRES_TEMPLATE?.trim() ||
    decodeURIComponent(shared.pathname.slice(1));
  const name = `xmatrix_hub_worker_${randomUUID().replaceAll("-", "")}`;
  await onMaintenanceDatabase(client => client.query(
    `CREATE DATABASE ${databaseIdentifier(name)} TEMPLATE ${databaseIdentifier(template)}`));
  const url = new URL(shared);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => onMaintenanceDatabase(client => client.query(
      `DROP DATABASE IF EXISTS ${databaseIdentifier(name)} WITH (FORCE)`)),
  };
}

/**
 * Start the scoped test worker with PostgreSQL launch authorities and the
 * controlled local Jev decision model (candidate_0).
 */
export async function startPgHubWorker({ vars = {} } = {}) {
  const database = await createTestWorkerDatabase();
  const url = database.url;
  const directory = mkdtempSync(join(tmpdir(), "xmatrix-hub-pg-fixture-"));
  const configPath = join(directory, "wrangler.toml");
  const decisionModel = resolve(hubDir, "test/fixtures/local-routing-decision.mjs");
  writeFileSync(
    configPath,
    `${readFileSync(join(hubDir, "wrangler.test.toml"), "utf8")}\n[alias]\n` +
      `"@xmatrix/decision-model" = ${JSON.stringify(decisionModel)}\n`,
  );
  let worker;
  try {
    worker = await startHubWorker({
      config: configPath,
      entrypoint: resolve(hubDir, "src/index-scoped-authority-test.ts"),
      vars: {
        AUTH_AUTHORITY: "postgres",
        SCOPED_CONTROL_FACT_MATERIALIZATION: "suppressed",
        CHANNEL_FAMILY_FACT_MATERIALIZATION: "suppressed",
        RELAY_POSTGRES: { connectionString: url },
        RELAY_POSTGRES_SHARD_ID: "shard-0",
        JEV_AI_GATEWAY_API_KEY: "local-fixture-not-a-provider-credential",
        ...vars,
      },
    });
  } catch (error) {
    await database.drop().catch(() => undefined);
    throw error;
  }
  workerDatabaseUrl = url;
  worker.postgresUrl = url;
  const stop = worker.stop.bind(worker);
  Object.defineProperty(worker, "stop", {
    configurable: true,
    value: async (...args) => {
      try { return await stop(...args); } finally {
        if (workerDatabaseUrl === url) workerDatabaseUrl = undefined;
        await database.drop();
      }
    },
  });
  return worker;
}

/** The Space a Channel belongs to. */
export async function channelSpaceId(channelId) {
  return (await inTestTransaction(tx => tx.query({ text: "SELECT space_id FROM data.channels WHERE channel_id=$1",
    values: [channelId] })))[0].space_id;
}

/**
 * Create the daemon, directory, Channel and registration a tagged `@auto`
 * launch needs. The registration names the directory, so it is an eligible
 * candidate for a `harness:`+`machine:`+`pwd:` launch.
 */
export async function createPgSpawnableScenario(
  worker,
  { agentName, harness = "codex", unique = randomUUID() } = {},
) {
  if (harness !== "codex") throw new Error("This lifecycle fixture currently supports only the Codex backend");
  const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
  const hostId = `pg-launch-host-${unique}`;
  const machineId = `machine:pg-launch-${unique}`;
  const canonicalCwd = `/tmp/xmatrix-pg-launch-${unique}`;

  const workspace = await createWorkspace(worker, { machineId, hostId, canonicalCwd,
    displayName: `pg-launch-${unique}`, runtime: harness });
  const channelId = (await createClosedChannel(worker, `pg-launch-${unique}`))?.id;
  if (typeof channelId !== "string") throw new Error("channel id missing");

  const daemon = await connectDaemon(worker, { machineId, hostId });
  const registration = await registerTestAgent(worker, { token: MOCK_TOKEN, spaceId: await channelSpaceId(channelId),
    ownerUserId: await testUserId(worker), machineId, hostId, harness, displayName: agentName,
    canonicalCwd });

  return { auth, workspace, channelId, daemon, registration, machineId, hostId, canonicalCwd };
}

/** Post a tagged `@auto` launch of a harness in a registered directory. */
export function postAutoLaunch(worker, { channelId, harness = "codex", machineId, canonicalCwd }, prompt, token = MOCK_TOKEN) {
  return postChannelMessage(worker, token, channelId,
    `@auto harness:${harness} machine:${machineId} pwd:"${canonicalCwd}" ${prompt}`);
}

/**
 * Launch one Run of the scenario's registration with a tagged `@auto`
 * mention and admit its spawn as the daemon does. Returns the spawn command,
 * the Run credential and the body an Agent Instance connects with.
 */
export async function launchScenarioRun(worker, scenario, prompt = "Start test Agent Run.") {
  const { daemon, channelId, registration, machineId, hostId, canonicalCwd } = scenario;
  const spawn = daemon.inbox.waitFor(message => message.channelId === channelId && isSpawnOf(message, registration),
    `registered spawn in ${channelId}`);
  await postAutoLaunch(worker, { channelId, harness: registration.harness, machineId, canonicalCwd }, prompt);
  const command = await spawn;
  const token = await admitRegisteredSpawn(worker, daemon, command);
  return { command, token, body: { identityId: command.identityId, name: command.agentName,
    agentType: command.runtime || registration.harness, metadata: { tool: command.runtime || registration.harness,
      machineId, hostId, workspaceMachineId: command.workspace?.machineId, workspaceCwd: command.workspace?.canonicalCwd,
      cwd: command.workspace?.canonicalCwd, canonicalCwd: command.workspace?.canonicalCwd, runId: command.runId,
      executionKey: command.executionKey, autoJoinChannelId: channelId, instanceId: command.instanceId } } };
}

/** One transaction on the test database, shaped like the authority's. */
export function inTestTransaction(body) {
  return inPostgresTransaction(testPostgresUrl(), body);
}

/** PostgreSQL worker with one explicit mock Human identity. */
export function startMockUserHubWorker({ id, email, name, token = MOCK_TOKEN, vars = {} }) {
  return startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: token, XMATRIX_MOCK_AUTH_USER_ID: id,
    XMATRIX_MOCK_AUTH_EMAIL: email, XMATRIX_MOCK_AUTH_NAME: name,
    ...vars,
  } });
}

/** A Space the token's Human creates and owns. */
export async function createSpace(worker, name, token = MOCK_TOKEN) {
  return (await json(await worker.fetch("/api/spaces", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }))).space;
}

/** An invite the Space's owner issues. */
export async function inviteToSpace(worker, spaceId, ownerToken, role = "member") {
  return (await json(await worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/invites`, {
    method: "POST", headers: { Authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ role }),
  }))).invite;
}

/** The invited Human accepts the invite and joins its Space. */
export async function acceptSpaceInvite(worker, invite, token) {
  return json(await worker.fetch(`/api/space-invites/${encodeURIComponent(invite.token)}/accept`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  }));
}

/** A fresh machine: its id and the host its daemon reports. */
export function testMachine(slug) {
  const unique = randomUUID();
  return { hostId: `${slug}-host-${unique}`, machineId: `machine:${slug}-${unique}` };
}

/** The connection a Machine Daemon of a CLI that runs registered launches opens. */
export function daemonIdentity({ machineId, hostId, capabilities = REGISTERED_DAEMON_CAPABILITIES }) {
  return { name: `xmatrix-daemon-${hostId}`, agentType: "xmatrix_daemon",
    metadata: { kind: "daemon", machineId, hostId, hostName: hostId, capabilities } };
}

/** Connect the Machine Daemon of a machine as the token's Human. */
export function connectDaemon(worker, machine, token = MOCK_TOKEN) {
  return connectAgent(worker, daemonIdentity(machine), token);
}

const homeSpaces = new WeakMap();

/** The Space a token's Human keeps its test Channels in, created on first use. */
export function homeSpaceId(worker, token = MOCK_TOKEN) {
  const byToken = homeSpaces.get(worker) ?? new Map();
  homeSpaces.set(worker, byToken);
  if (!byToken.has(token)) byToken.set(token, createSpace(worker, "Home", token).then((space) => space.id));
  return byToken.get(token);
}

/** A closed Channel the token's Human creates. */
export async function createClosedChannel(worker, name, token = MOCK_TOKEN) {
  return (await json(await worker.fetch("/api/channels", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ spaceId: await homeSpaceId(worker, token), mode: "closed", name, access: [] }),
  }))).channel;
}

/** A directory the token's Human registers on a machine. */
export async function createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName, runtime = "codex" },
  token = MOCK_TOKEN) {
  return (await json(await worker.fetch("/api/workspaces", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ machineId, hostId, hostName: hostId, canonicalCwd, displayName, runtime }),
  }))).workspace;
}

/** Answer a spawn command over the daemon socket the way the daemon does. */
export function sendSpawnResult(daemon, command, result) {
  daemon.ws.send(JSON.stringify({
    type: "machine_spawn_result",
    requestId: command.requestId,
    launchId: command.launchId,
    instanceId: command.instanceId,
    runId: command.runId,
    executionKey: command.executionKey,
    machineId: command.workspace.machineId,
    canonicalCwd: command.workspace.canonicalCwd,
    channelId: command.channelId,
    agentName: command.agentName,
    identityId: command.identityId,
    relayLease: command.relayLease,
    ...result,
  }));
}

/** A daemon's answer to a stop command, echoing the exact retain/session target it was issued. */
export function stopResultFor(command, result) {
  return {
    type: "machine_stop_result",
    requestId: command.requestId,
    ...(command.resumeSessionKey ? { resumeSessionKey: command.resumeSessionKey } : {}),
    ...(command.worktreeDisposition ? { worktreeDisposition: command.worktreeDisposition } : {}),
    runId: command.runId,
    executionKey: command.executionKey,
    agentId: command.agentId,
    instanceId: command.instanceId,
    relayLease: command.relayLease,
    ...result,
  };
}

/** Answer a stop command over the daemon socket the way the daemon does. */
export function sendStopResult(daemon, command, result) {
  daemon.ws.send(JSON.stringify(stopResultFor(command, result)));
}

/** Turn on a Space's Management Agent with side effects, as its admin does. */
export function enableManagementAgent(worker, spaceId, token = MOCK_TOKEN) {
  return worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/management-agent`, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, sideEffectsEnabled: true }),
  });
}

/**
 * The owner's Codex harness registered in a Space on a fresh machine whose
 * daemon is connected, with a directory of its own.
 */
export async function registerCodexOnFreshMachine(worker, { ownerUserId, spaceId, slug, displayName,
  launch = { runtime: "codex", backend: "codex-app", runtimeArgs: [] } }) {
  const { hostId, machineId } = testMachine(slug);
  const canonicalCwd = `/tmp/xmatrix-${slug}-${randomUUID()}`;
  const daemon = await connectDaemon(worker, { machineId, hostId });
  await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: slug });
  await registerTestAgent(worker, { token: MOCK_TOKEN, spaceId, ownerUserId, machineId, harness: "codex", displayName,
    canonicalCwd, launch });
  return { daemon, machineId, hostId, canonicalCwd };
}

/**
 * A Run of the owner's registered Codex harness, launched by a mention in a
 * fresh closed Channel, admitted, connected and joined to that Channel.
 */
export async function launchMentionedCodexRun(worker, { ownerUserId, slug, displayName, mention, launch }) {
  const channel = await createClosedChannel(worker, `${slug}-${randomUUID()}`);
  const spaceId = await channelSpaceId(channel.id);
  const machine = await registerCodexOnFreshMachine(worker, { ownerUserId, spaceId, slug, displayName, launch });
  const spawn = machine.daemon.inbox.waitFor(message => message.type === "machine_spawn_agent"
    && message.channelId === channel.id, `${displayName} spawn`);
  await postChannelMessage(worker, MOCK_TOKEN, channel.id, mention);
  const command = await spawn;
  const runToken = await admitRegisteredSpawn(worker, machine.daemon, command);
  const agent = await connectAgent(worker, runAgentConnection(command, channel.id, machine), runToken);
  const joined = await agent.request({ type: "join_channel", channelId: channel.id, historyLimit: 0 });
  assert.equal(joined.type, "channel_joined", JSON.stringify(joined));
  return { ...machine, agent, channel, spaceId, command, runToken };
}

/** A registered harness with its own directory on the given machine. */
export async function createRoutableAgent(worker, { token = MOCK_TOKEN, spaceId, ownerUserId, name, machineId, hostId,
  harness = "codex", capabilities = [] }) {
  const canonicalCwd = `/tmp/xmatrix-registered-${randomUUID()}`;
  const workspace = await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: name, runtime: harness },
    token);
  const key = await registerTestAgent(worker, { token, spaceId, ownerUserId: ownerUserId ?? await testUserId(worker, token),
    machineId, hostId, harness, displayName: name, canonicalCwd, capabilities });
  return { key, workspace, canonicalCwd };
}

export {
  MOCK_TOKEN,
  connectAgent,
  json,
  postChannelMessage,
  randomUUID,
  startHubWorker,
};
