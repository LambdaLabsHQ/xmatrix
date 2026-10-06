import { websocketInbox } from "./support/websocket-inbox.mjs";
import { unstable_dev } from "wrangler";
import { after } from "node:test";
import {
  REGISTERED_DAEMON_CAPABILITIES,
  launchRegisteredRun,
} from "./registration-launch.fixture.mjs";
import {
  captureOpenFileDescriptors,
  fileDescriptorDelta,
  HubWorkerResourceAudit,
  listPosixDescendantProcesses,
} from "./hub-test-resources.mjs";

/**
 * Shared helpers for Hub Wrangler e2e tests.
 *
 * Concurrent unstable_dev() workers share .wrangler/state SQLite by default.
 * startHubWorker() gives every worker private binding state (in memory, or a
 * directory the test names) and keeps it out of
 * Wrangler's shared dev registry, so tests are safe to run in parallel.
 * openWebSocket retries flaky opens under load.
 */

const workerResourceAudit = new HubWorkerResourceAudit();
const fileDescriptorsAtImport = captureOpenFileDescriptors();
/** @type {Set<() => Promise<void>>} */
const fileScopedWorkerStops = new Set();
// Wrangler lazily opens a small, process-local compiler/telemetry descriptor
// set (six on current macOS) which is reclaimed when this test-file process
// exits. A much larger residual still catches forgotten socket/client storms;
// leaked Workerd processes are tracked exactly below and have zero tolerance.
const PER_FILE_FD_LEAK_TOLERANCE = 32;
const TEST_CLIENT_COMPATIBILITY_HEADERS = Object.freeze({
  "x-xmatrix-client-component": "app",
  "x-xmatrix-client-version": "0.16.698",
  "x-xmatrix-client-protocol": "2",
});
const TEST_CLIENT_VERSION = TEST_CLIENT_COMPATIBILITY_HEADERS["x-xmatrix-client-version"];

after(async () => {
  // File-scoped workers register stop callbacks here so they always run before
  // the leak audit, regardless of node:test after-hook registration order.
  const stops = [...fileScopedWorkerStops];
  fileScopedWorkerStops.clear();
  await Promise.all(stops.map((stop) => stop()));
  const workerLeaks = await workerResourceAudit.cleanupLeaks();
  // Workerd and its sockets close asynchronously after unstable_dev.stop().
  // Give libuv one bounded turn before comparing this test file with its
  // import-time descriptor baseline.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const finalDescriptors = captureOpenFileDescriptors();
  // Wrangler keeps one esbuild service scoped to this disposable test-file
  // process; Node reaps it at file exit. Workerd/Wrangler children must be gone.
  const remainingChildren = listPosixDescendantProcesses().filter(
    (child) => !/(?:^|\/)esbuild(?:\.exe)?$/.test(child.command)
  );
  const openedDescriptors = fileDescriptorDelta(fileDescriptorsAtImport, finalDescriptors);
  const fdDelta = fileDescriptorsAtImport.supported && finalDescriptors.supported
    ? finalDescriptors.descriptors.length - fileDescriptorsAtImport.descriptors.length
    : 0;

  if (
    workerLeaks.leaked.length === 0
    && remainingChildren.length === 0
    && fdDelta <= PER_FILE_FD_LEAK_TOLERANCE
  ) return;

  const details = workerLeaks.leaked.map((record) => {
    const location = record.address && record.port ? ` at ${record.address}:${record.port}` : "";
    const ageMs = Math.max(0, Date.now() - record.createdAt);
    return `worker#${record.id} ${record.entrypoint}${location}, age=${ageMs}ms`
      + (record.creationStack ? `\n${record.creationStack}` : "");
  });
  if (workerLeaks.cleanupFailures.length > 0) {
    details.push(
      `cleanup failures: ${workerLeaks.cleanupFailures
        .map((failure) => `worker#${failure.id}: ${failure.error}`)
        .join("; ")}`
    );
  }
  if (fdDelta > PER_FILE_FD_LEAK_TOLERANCE) {
    details.push(
      `file descriptors: before=${fileDescriptorsAtImport.descriptors.length}, `
      + `after=${finalDescriptors.descriptors.length}, delta=${fdDelta}, `
      + `new=${openedDescriptors?.join(",") || "unknown"}`
    );
  }
  if (remainingChildren.length > 0) {
    details.push(
      `remaining child processes: ${remainingChildren
        .map((child) => `pid=${child.pid} ppid=${child.ppid} command=${child.command}`)
        .join("; ")}`
    );
  }
  throw new Error(`Hub e2e resource leak detected:\n${details.join("\n")}`);
});

/**
 * File-scoped shared worker for multi-test e2e files that use identical
 * startHubWorker options and do not require empty storage between cases.
 * Prefer unique entity ids over process-per-test isolation.
 */
export function createFileScopedHubWorker(options = {}, startWorker = startHubWorker) {
  /** @type {Awaited<ReturnType<typeof startHubWorker>> | null} */
  let worker = null;
  /** @type {Promise<Awaited<ReturnType<typeof startHubWorker>>> | null} */
  let starting = null;

  async function stop() {
    const current = worker;
    worker = null;
    starting = null;
    if (current) await current.stop();
  }

  fileScopedWorkerStops.add(stop);

  return {
    async get() {
      if (worker) return worker;
      starting ??= startWorker(options);
      worker = await starting;
      return worker;
    },
    stop,
  };
}

/** Start one Hub worker with process-local, non-shared binding state. */
export async function startHubWorker(options = {}) {
  const { entrypoint = "src/index-scoped-authority-test.ts", persistTo, ...workerOptions } = options;
  const creationStack = new Error("Hub worker created here").stack
    ?.split("\n")
    .slice(1, 8)
    .join("\n");
  const worker = await unstable_dev(entrypoint, {
    config: "wrangler.test.toml",
    local: true,
    logLevel: "error",
    ...workerOptions,
    vars: {
      // Domain credentials are intentionally signed even in local tests. Keep
      // the signing boundary real instead of teaching product code a mock
      // credential bypass.
      BETTER_AUTH_SECRET: "xmatrix-hub-e2e-domain-principal-signing-secret",
      XMATRIX_SECRET_CATALOG_KEY: "xmatrix-hub-e2e-dedicated-secret-authority-key",
      ...workerOptions.vars,
    },
    ...(persistTo ? { persist: true, persistTo } : { persist: false }),
    experimental: {
      // Keep real Worker HTTP/auth/bindings, but omit Wrangler's extra dev
      // proxy hop: its pooled sockets race workerd's five-second idle timeout.
      // This pinned-patch option sends writes once over fresh connections.
      directLocalFetch: true,
      ...workerOptions.experimental,
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      testMode: true,
    },
  });
  const fetch = worker.fetch.bind(worker);
  worker.fetch = (input, init = undefined) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
    for (const [name, value] of Object.entries(TEST_CLIENT_COMPATIBILITY_HEADERS)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    if (input instanceof Request) return fetch(new Request(input, { ...init, headers }));
    return fetch(input, { ...init, headers });
  };
  return workerResourceAudit.track(worker, { entrypoint, creationStack });
}

export function wsUrl(worker) {
  const host = worker.address.includes(":") ? `[${worker.address}]` : worker.address;
  return `ws://${host}:${worker.port}/ws`;
}

export function agentInstanceWsUrl(worker) {
  return compatibleSocketUrl(worker, "/agent-instances", "cli");
}

export function machineDaemonWsUrl(worker) {
  return compatibleSocketUrl(worker, "/machine-daemons", "daemon");
}

export function humanWsUrl(worker) {
  return compatibleSocketUrl(worker, "/humans", "app");
}

function compatibleSocketUrl(worker, path, component) {
  const url = new URL(`${wsUrl(worker)}${path}`);
  url.searchParams.set("x-xmatrix-client-component", component);
  url.searchParams.set("x-xmatrix-client-version", "0.16.698");
  url.searchParams.set("x-xmatrix-client-protocol", "2");
  return url.toString();
}

const bootstrapChannelsByWorker = new WeakMap();
const machineDaemonsByWorker = new WeakMap();

function machineDaemonCache(worker) {
  let cache = machineDaemonsByWorker.get(worker);
  if (!cache) {
    cache = new Map();
    machineDaemonsByWorker.set(worker, cache);
  }
  return cache;
}

function machineDaemonKey(machineId, hostId) {
  return `${machineId || ""}:${hostId || ""}`;
}

export function rememberTestMachineDaemon(worker, machineId, hostId, daemon) {
  machineDaemonCache(worker).set(machineDaemonKey(machineId, hostId), daemon);
}

export async function mintMachineDaemonCredential(worker, token, identity) {
  const payload = await jsonResponse(await worker.fetch("/api/machine-daemon-credentials", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      machineId: identity.machineId,
      hostId: identity.hostId,
      hostName: identity.hostName,
    }),
  }));
  return payload.credential;
}

async function jsonResponse(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.error || text || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function fixtureRuntimeMetadata(metadata = {}, identitySeed) {
  const suffix = crypto.randomUUID();
  const next = { ...metadata };
  const stableSeed = typeof identitySeed === "string"
    ? identitySeed.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80)
    : "";
  const hostId = next.hostId
    || next.hostName
    || next.hostname
    || (stableSeed ? `e2e-${stableSeed}` : `e2e-${suffix}`);
  next.hostId = hostId;
  next.hostName = next.hostName || next.hostname || hostId;
  next.machineId = next.machineId || `machine:${hostId}`;
  return next;
}

function principalType(token) {
  if (typeof token !== "string") return undefined;
  const [, encoded] = token.split(".");
  if (!encoded) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload.principalType || (payload.xmatrixAgentRun ? "agent_run" : undefined);
  } catch {
    return undefined;
  }
}

async function bootstrapChannel(worker, token, spaceId) {
  let cache = bootstrapChannelsByWorker.get(worker);
  if (!cache) {
    cache = new Map();
    bootstrapChannelsByWorker.set(worker, cache);
  }
  const key = `${token}:${spaceId ?? ""}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  // Without a named Space the fixture keeps its Channel in a Space of its own.
  const channelSpaceId = spaceId || (await jsonResponse(await worker.fetch("/api/spaces", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Agent run fixture" }),
  }))).space.id;
  const channel = (await jsonResponse(await worker.fetch("/api/channels", {
    method: "POST",
    headers,
    body: JSON.stringify({
      spaceId: channelSpaceId,
      mode: "closed",
      name: `Agent run fixture ${crypto.randomUUID().slice(0, 8)}`,
      access: [],
    }),
  }))).channel;
  cache.set(key, channel);
  return channel;
}

/**
 * Materialize a real Agent Run for behavioral fixtures that need a connected
 * Agent. A Run exists only as a Run of a Space Agent Registration, so this
 * registers the harness on the fixture's machine and launches it through the
 * tagged `@auto` mention, the daemon spawn and its admission — the public
 * paths a real owner and CLI take. The machine's daemon is the test's own
 * when it connected one, otherwise one opened for the worker's lifetime.
 */
/** A registered Codex Run on a distinct test Machine and host. */
export function prepareFreshCodexRun(worker, name, token, metadata = {}) {
  return prepareTestAgentRun(worker, {
    name,
    agentType: "codex",
    metadata: {
      tool: "codex",
      machineId: `machine:${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`,
      hostId: `host-${crypto.randomUUID()}`,
      ...metadata,
    },
  }, token);
}

export async function prepareTestAgentRun(worker, body, token) {
  const { targetChannelId, spaceId, spaceAdminToken, autoProvisionRun: _autoProvisionRun, ...connectionBody } = body;
  if (principalType(token) === "agent_run") {
    return { body: connectionBody, token };
  }
  const metadata = fixtureRuntimeMetadata(connectionBody.metadata, connectionBody.name);
  const { machineId, hostId, hostName } = metadata;
  const channelId = targetChannelId ?? (await bootstrapChannel(worker, token, spaceId)).id;
  const daemon = await machineDaemonFor(worker, token, { machineId, hostId, hostName });
  const launched = await launchRegisteredRun(worker, { token, spaceAdminToken, daemon, channelId, machineId,
    harness: connectionBody.agentType || "codex", displayName: registrationDisplayName(connectionBody.name) });
  const { command } = launched;
  return {
    token: launched.token,
    body: {
      ...connectionBody,
      identityId: command.identityId,
      agentType: command.runtime || connectionBody.agentType,
      metadata: {
        ...metadata,
        tool: command.runtime || connectionBody.agentType,
        workspaceMachineId: command.workspace?.machineId,
        workspaceCwd: command.workspace?.canonicalCwd,
        workspaceName: command.workspace?.displayName,
        cwd: command.workspace?.canonicalCwd,
        canonicalCwd: command.workspace?.canonicalCwd,
        runId: command.runId,
        executionKey: command.executionKey,
        autoJoinChannelId: channelId,
        instanceId: command.instanceId,
        registration: command.registration,
      },
    },
  };
}

/** A registration display name is a mention name: letters, digits, `-`, `_`, `.`. */
function registrationDisplayName(name) {
  const cleaned = String(name || "agent").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[^A-Za-z0-9]+/u, "");
  return (cleaned || "agent").slice(0, 64);
}

/** The machine's live test daemon, connecting one with registered-launch capabilities if absent. */
async function machineDaemonFor(worker, token, { machineId, hostId, hostName }) {
  const cached = machineDaemonCache(worker).get(machineDaemonKey(machineId, hostId));
  if (cached) return { ...cached, hostId };
  const connection = await connectTestRuntime(worker, { name: `xmatrix-daemon-${hostId}`, agentType: "xmatrix_daemon",
    metadata: { kind: "daemon", machineId, hostId, hostName, capabilities: REGISTERED_DAEMON_CAPABILITIES } },
  token, createTestInbox);
  const stop = worker.stop.bind(worker);
  worker.stop = async (...args) => {
    connection.ws.close();
    return stop(...args);
  };
  return { ...connection, hostId };
}

/** Open one domain-specific runtime connection without touching Profile storage. */
export async function connectTestRuntime(worker, body, token, makeInbox) {
  const { autoProvisionRun = true } = body;
  let { spaceId: _spaceId, spaceAdminToken: _spaceAdminToken, autoProvisionRun: _ignored, ...connectionBody } = body;
  const clientVersion = connectionBody.clientVersion || TEST_CLIENT_VERSION;
  const isDaemon = connectionBody.agentType === "xmatrix_daemon";

  if (!isDaemon && autoProvisionRun && principalType(token) !== "agent_run") {
    const prepared = await prepareTestAgentRun(worker, body, token);
    connectionBody = prepared.body;
    token = prepared.token;
  }

  const ws = await openWebSocket(isDaemon ? machineDaemonWsUrl(worker) : agentInstanceWsUrl(worker));
  const inbox = makeInbox(ws);
  const expectedType = isDaemon ? "machine_daemon_connected" : "agent_instance_connected";
  let machineCredential;
  if (isDaemon) {
    const machineId = connectionBody.metadata?.machineId;
    const hostId = connectionBody.metadata?.hostId;
    if (!machineId || !hostId) {
      ws.close();
      throw new Error("Machine Daemon e2e fixtures require metadata.machineId and metadata.hostId");
    }
    const credential = await mintMachineDaemonCredential(worker, token, {
      machineId,
      hostId,
      hostName: connectionBody.metadata?.hostName || connectionBody.metadata?.hostname,
    });
    machineCredential = credential;
    ws.send(JSON.stringify({
      type: "machine_daemon_connect",
      token: credential,
      displayName: connectionBody.name,
      machineId,
      hostId,
      hostName: connectionBody.metadata?.hostName || connectionBody.metadata?.hostname,
      clientVersion,
      protocolVersion: 2,
      capabilities: connectionBody.capabilities || connectionBody.metadata?.capabilities,
      machineMetadata: connectionBody.metadata,
    }));
  } else {
    ws.send(JSON.stringify({
      type: "agent_instance_connect",
      token,
      identityId: connectionBody.identityId,
      name: connectionBody.name,
      runtime: {
        kind: connectionBody.agentType,
        clientVersion,
        protocolVersion: 2,
        capabilities: connectionBody.capabilities,
      },
      runContext: connectionBody.metadata,
    }));
  }

  const connected = await inbox.waitFor(
    (message) => message.type === expectedType || message.type === "error",
    expectedType
  );
  if (connected.type === "error") {
    ws.close();
    throw Object.assign(new Error(connected.message), { failure: connected.failure });
  }
  if (isDaemon) {
    rememberTestMachineDaemon(
      worker,
      connectionBody.metadata?.machineId,
      connectionBody.metadata?.hostId,
      { ws, inbox, credential: machineCredential }
    );
  }
  return {
    ws,
    inbox,
    agent: isDaemon ? connected.daemon : connected.agent,
    connectionEpoch: isDaemon ? connected.connectionEpoch : undefined,
    machineCredential,
  };
}

/**
 * Give a real AgentInstance test socket the same host-local trace behavior as
 * the CLI runtime. Hub tests must exercise the request/result protocol; keeping
 * an in-test process map here prevents them from accidentally depending on a
 * Hub/Authority/R2 trace ledger.
 */
export function installTestAgentTraceHost(connection) {
  if (connection.__testAgentTraceHostInstalled) return connection;
  connection.__testAgentTraceHostInstalled = true;

  // One fixture socket represents one exact Agent Instance host. The public
  // connected-agent projection deliberately omits its instance id, so bind the
  // in-process store to the first Hub history request instead of reaching into
  // Hub state or inventing a second source of identity truth.
  let boundInstanceId;
  let events = [];
  const send = connection.ws.send.bind(connection.ws);
  connection.ws.send = (raw) => {
    const message = JSON.parse(raw);
    if (message.type === "event_publish" && message.eventType === "llm_trace") {
      message.eventId ||= crypto.randomUUID();
      message.timestamp ||= new Date().toISOString();
      events.unshift({
        id: message.eventId,
        type: "event_published",
        workspaceUserId: connection.agent.userId,
        agentId: connection.agent.id,
        agentName: connection.agent.name,
        channelId: message.channelId,
        metadata: { eventType: "llm_trace", payload: message.payload },
        timestamp: message.timestamp,
      });
      events = events.slice(0, 500);
    }
    if (message.type === "unregister") {
      events = [];
    }
    send(JSON.stringify(message));
  };

  connection.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "shutdown_requested") {
      events = [];
      return;
    }
    if (message.type !== "trace_history_requested") return;
    if (boundInstanceId && boundInstanceId !== message.instanceId) {
      send(JSON.stringify({
        type: "trace_history_result",
        requestId: message.requestId,
        instanceId: message.instanceId,
        availability: "unavailable",
        complete: false,
        events: [],
      }));
      return;
    }
    boundInstanceId ||= message.instanceId;
    const eligible = events
      .filter((item) => !message.since || item.timestamp >= message.since);
    const responseEvents = eligible.slice(0, message.maxEvents);
    send(JSON.stringify({
      type: "trace_history_result",
      requestId: message.requestId,
      instanceId: message.instanceId,
      availability: "available",
      complete: responseEvents.length === eligible.length,
      events: responseEvents,
    }));
  });

  return connection;
}

/**
 * A behavioral-test fixture over one registered harness which opens a real,
 * channel-scoped Agent Run lazily for each channel the fixture exercises.
 */
export async function connectTestAgentFixture(worker, body, token, makeInbox) {
  const callerBody = body;
  body = { ...body, metadata: fixtureRuntimeMetadata(body.metadata, body.name) };
  const hasAssignedRun = Boolean(
    body.identityId
    && body.metadata?.runId
    && body.metadata?.executionKey
    && body.metadata?.autoJoinChannelId
  );
  if (body.agentType === "xmatrix_daemon" || hasAssignedRun) {
    const connection = installTestAgentTraceHost(
      await connectTestRuntime(worker, body, token, makeInbox)
    );
    return {
      ...connection,
      request(message) {
        return requestTestConnectionCommand(
          worker,
          token,
          connection.ws,
          connection.inbox,
          message
        );
      },
    };
  }

  // A registration Run acts as its Instance, so the Agent's id is the first
  // Run's Instance; every further Channel gets its own Run of the registration.
  const agent = {
    id: undefined,
    name: body.name,
    type: body.agentType,
    metadata: body.metadata || {},
    online: false,
    status: "offline",
    instances: [],
  };
  const connections = new Map();
  const pendingListeners = [];
  let latest;
  let latestConnection;
  let closed = false;

  async function ensureRun(channelId) {
    const key = channelId || "__fixture__";
    if (connections.has(key)) return connections.get(key);
    const pending = (async () => {
      const prepared = await prepareTestAgentRun(
        worker,
        { ...body, targetChannelId: channelId },
        token
      );
      callerBody.identityId ??= prepared.body.identityId;
      callerBody.metadata = callerBody.metadata || {};
      Object.assign(callerBody.metadata, prepared.body.metadata || {});
      const connection = installTestAgentTraceHost(
        await connectTestRuntime(
          worker,
          prepared.body,
          prepared.token,
          makeInbox
        )
      );
      Object.assign(agent, connection.agent);
      agent.id ??= prepared.body.identityId;
      agent.metadata = {
        ...connection.agent.metadata,
        ...prepared.body.metadata,
      };
      for (const [type, listener, options] of pendingListeners) {
        connection.ws.addEventListener(type, listener, options);
      }
      if (closed) connection.ws.close();
      return connection;
    })();
    connections.set(key, pending);
    latest = pending;
    void pending.then((connection) => {
      if (latest === pending) latestConnection = connection;
    });
    return pending;
  }

  const ws = {
    get readyState() {
      return closed
        ? WebSocket.CLOSED
        : latestConnection?.ws.readyState ?? WebSocket.OPEN;
    },
    send(raw) {
      const message = JSON.parse(raw);
      const connection = message.channelId ? ensureRun(message.channelId) : (latest || ensureRun());
      void connection.then((active) => active.ws.send(raw));
    },
    close(code, reason) {
      closed = true;
      for (const pending of connections.values()) {
        void pending.then((connection) => connection.ws.close(code, reason)).catch(() => {});
      }
    },
    addEventListener(type, listener, options) {
      pendingListeners.push([type, listener, options]);
      for (const pending of connections.values()) {
        void pending.then((connection) => connection.ws.addEventListener(type, listener, options));
      }
    },
  };
  const inbox = {
    async waitFor(predicate, label, timeoutMs) {
      const connection = await (latest || ensureRun());
      return connection.inbox.waitFor(predicate, label, timeoutMs);
    },
  };
  return {
    ws,
    inbox,
    agent,
    async request(message) {
      if (message.type === "create_channel") {
        const result = await requestTestConnectionCommand(worker, token, ws, inbox, message);
        await ensureRun(result.channel.id);
        return result;
      }
      if (["create_space", "list_channels"].includes(message.type)) {
        return requestTestConnectionCommand(worker, token, ws, inbox, message);
      }
      const { reuseCurrentRun = false, ...wireMessage } = message;
      const connection = (reuseCurrentRun || !message.channelId) && latest
        ? await latest
        : await ensureRun(message.channelId);
      return requestTestConnectionCommand(
        worker,
        token,
        connection.ws,
        connection.inbox,
        wireMessage
      );
    },
  };
}

/** Route test commands through the domain that owns them. */
export async function requestTestConnectionCommand(
  worker,
  humanToken,
  ws,
  inbox,
  message
) {
  const requestId = message.requestId || crypto.randomUUID();
  const { type, requestId: _requestId, ...payload } = message;
  const headers = {
    Authorization: `Bearer ${humanToken}`,
    "content-type": "application/json",
  };
  if (type === "create_channel") {
    const result = await jsonResponse(await worker.fetch("/api/channels", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }));
    return { type: "channel_created", requestId, channel: result.channel };
  }
  if (type === "create_space") {
    const result = await jsonResponse(await worker.fetch("/api/spaces", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }));
    return { type: "space_created", requestId, space: result.space };
  }
  if (type === "list_channels") {
    const query = new URLSearchParams();
    if (payload.spaceId) query.set("spaceId", payload.spaceId);
    const result = await jsonResponse(await worker.fetch(
      `/api/channels${query.size ? `?${query}` : ""}`,
      { headers }
    ));
    return { type: "channel_list", requestId, channels: result.channels || [] };
  }

  ws.send(JSON.stringify({ ...message, requestId }));
  return inbox.waitFor(
    (response) => response.requestId === requestId,
    `${type} response${typeof payload.channelId === "string" ? ` for ${payload.channelId}` : ""}`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTestInbox(ws) {
  return websocketInbox(ws, { cleanupExpiredWaiters: true, timeoutLabel: "Timed out" });
}

/**
 * Wait for a single WebSocket instance to open.
 * Handles already-open sockets so late listener registration does not hang.
 * @param {WebSocket} ws
 * @param {number} [timeoutMs]
 */
export function waitForOpen(ws, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      reject(new Error("WebSocket already closed before open"));
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("Timed out opening WebSocket")),
      timeoutMs
    );
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("WebSocket error before open"));
      },
      { once: true }
    );
  });
}

/**
 * Open a WebSocket with retries for flaky local/self-hosted runners.
 * @param {string} url
 * @param {{ attempts?: number, timeoutMs?: number, WebSocketImpl?: typeof WebSocket, protocols?: string | string[] }} [options]
 */
export async function openWebSocket(url, options = {}) {
  const attempts = options.attempts ?? 4;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ws = options.protocols === undefined
      ? new WebSocketImpl(url)
      : new WebSocketImpl(url, options.protocols);
    try {
      await waitForOpen(ws, timeoutMs);
      return ws;
    } catch (error) {
      lastError = error;
      try {
        ws.close();
      } catch {
        // ignore close races on failed opens
      }
      if (attempt < attempts) {
        await sleep(200 * attempt);
      }
    }
  }
  throw lastError ?? new Error("Timed out opening WebSocket");
}

/**
 * @param {WebSocket} ws
 * @param {number} [timeoutMs]
 */
export function waitForClose(ws, timeoutMs = 8_000) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket close")),
      timeoutMs
    );
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
