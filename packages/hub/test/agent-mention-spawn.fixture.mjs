import {
  agentInstanceWsUrl,
  createTestInbox as makeInbox,
  connectTestAgentFixture,
  humanWsUrl,
  machineDaemonWsUrl,
  mintMachineDaemonCredential,
  openWebSocket,
  rememberTestMachineDaemon,
  requestTestConnectionCommand,
  startHubWorker,
  waitForClose,
} from "./e2e-utils.mjs";
import { admitRegisteredSpawn } from "./registration-launch.fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const MOCK_TOKEN = "hub-agent-mention-spawn-e2e-token";


async function connectAgent(worker, body, token = MOCK_TOKEN) {
  if (body.agentType !== "xmatrix_daemon") {
    return connectTestAgentFixture(worker, body, token, makeInbox);
  }
  const { spaceId: _spaceId, ...connectionBody } = body;
  const prepared = { body: connectionBody, token };
  const registeredAgent = await registerAgent(worker, prepared.body, prepared.token);
  const responseType = body.agentType === "xmatrix_daemon"
    ? "machine_daemon_connected"
    : "agent_instance_connected";
  const registered = await registeredAgent.inbox.waitFor(
    (message) => message.type === responseType || message.type === "error" || message.type === "shutdown",
    responseType
  );
  if (registered.type !== responseType) {
    registeredAgent.ws.close();
    throw new Error(`${responseType} failed: ${JSON.stringify(registered)}`);
  }
  if (body.agentType === "xmatrix_daemon") {
    rememberTestMachineDaemon(
      worker,
      body.metadata?.machineId,
      body.metadata?.hostId,
      registeredAgent
    );
  }
  return {
    ...registeredAgent,
    agent: body.agentType === "xmatrix_daemon" ? registered.daemon : registered.agent,
    connectionEpoch: body.agentType === "xmatrix_daemon"
      ? registered.connectionEpoch
      : undefined,
    async request(message) {
      return requestTestConnectionCommand(
        worker,
        token,
        registeredAgent.ws,
        registeredAgent.inbox,
        message
      );
    },
  };
}

async function registerAgent(worker, body, token = MOCK_TOKEN) {
  const isDaemon = body.agentType === "xmatrix_daemon";
  const ws = await openWebSocket(isDaemon ? machineDaemonWsUrl(worker) : agentInstanceWsUrl(worker));
  const inbox = makeInbox(ws);
  let machineCredential;

  if (isDaemon) {
    const machineId = body.metadata?.machineId;
    const hostId = body.metadata?.hostId;
    const hostName = body.metadata?.hostName || body.metadata?.hostname;
    const credential = await mintMachineDaemonCredential(worker, token, {
      machineId,
      hostId,
      hostName,
    });
    machineCredential = credential;
    ws.send(JSON.stringify({
      type: "machine_daemon_connect",
      token: credential,
      displayName: body.name,
      machineId,
      hostId,
      hostName,
      clientVersion: body.clientVersion || "0.16.698",
      protocolVersion: 2,
      capabilities: body.capabilities || body.metadata?.capabilities,
      machineMetadata: body.metadata,
    }));
  } else {
    ws.send(JSON.stringify({
      type: "agent_instance_connect",
      token,
      identityId: body.identityId,
      name: body.name,
      runtime: {
        kind: body.agentType,
        clientVersion: body.clientVersion || "0.16.698",
        protocolVersion: 2,
        capabilities: body.capabilities,
      },
      runContext: body.metadata,
    }));
  }
  return {
    ws,
    inbox,
    machineCredential,
    async request(message) {
      const requestId = randomUUID();
      ws.send(JSON.stringify({ ...message, requestId }));
      return inbox.waitFor(
        (response) => response.requestId === requestId,
        `${message.type}${message.channelId ? ` ${message.channelId}` : ""} response for ${body.metadata?.runId || body.name}`
      );
    },
  };
}

async function connectUser(worker, token = MOCK_TOKEN) {
  const ws = await openWebSocket(humanWsUrl(worker));
  const inbox = makeInbox(ws);

  ws.send(JSON.stringify({
    type: "human_connect",
    token,
    device: { client: "desktop", version: "0.16.698", protocolVersion: 2 },
  }));
  await inbox.waitFor((message) => message.type === "human_connected", "human_connected");
  return { ws, inbox };
}

async function json(response) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    assert.fail(`Expected JSON response, got: ${text}`);
  }
  assert.equal(response.ok, true, text);
  return payload;
}

async function postChannelMessage(worker, token, channelId, body, extra = {}) {
  return json(
    await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body, ...extra }),
    })
  );
}

// Explicit lifecycle setup, independent of the retired message launch grammar.
async function channelHistory(worker, token, channelId, limit = 20) {
  return json(
    await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/history?limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  );
}

/** Admit a registered spawn as its daemon does before starting it; returns the Run credential. */
async function mintAgentRunToken(worker, daemon, spawn, _channelId) {
  return admitRegisteredSpawn(worker, daemon, spawn);
}

/**
 * The connection a spawned Run's Agent Instance opens to join its Channel. Its
 * machine defaults to the spawn's directory's.
 */
function runAgentConnection(spawn, channelId, { machineId = spawn.workspace.machineId, hostId = spawn.workspace.hostId } = {}) {
  const tool = spawn.runtime || "codex";
  return {
    identityId: spawn.identityId,
    name: spawn.agentName,
    agentType: tool,
    metadata: {
      tool,
      machineId,
      hostId,
      workspaceMachineId: spawn.workspace.machineId,
      workspaceCwd: spawn.workspace.canonicalCwd,
      cwd: spawn.workspace.canonicalCwd,
      runId: spawn.runId,
      executionKey: spawn.executionKey,
      autoJoinChannelId: channelId,
    },
  };
}

/**
 * Consume a real Machine Daemon spawn command with a provider-free mock Agent.
 *
 * This intentionally crosses every Hub boundary used by a production summon:
 * machine credential -> run credential -> Agent Instance WebSocket -> Channel
 * join -> Agent-authored WebSocket message. Only the external model process is
 * mocked, so regressions in routing, authorization, registration, or delivery
 * fail before the mock can reply.
 */
async function connectSpawnedMockAgent(worker, daemon, spawn, channelId) {
  const runToken = await mintAgentRunToken(worker, daemon, spawn, channelId);
  const agent = await connectAgent(worker, runAgentConnection(spawn, channelId), runToken);
  const joined = await agent.request({ type: "join_channel", channelId, historyLimit: 0 });
  assert.equal(joined.type, "channel_joined");
  assert.equal(joined.channelId, channelId);

  return {
    ...agent,
    runToken,
    async reply(body) {
      const dispatched = await agent.request({ type: "channel_message", channelId, body });
      assert.equal(dispatched.type, "channel_message_dispatched");
      assert.equal(dispatched.channelId, channelId);
      return waitForChannelHistoryMessage(
        worker,
        MOCK_TOKEN,
        channelId,
        (message) => message.body === body,
        "mock Agent channel response",
      );
    },
  };
}

async function waitForChannelHistoryMessage(
  worker,
  token,
  channelId,
  predicate,
  label,
  timeoutMs = 15_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await channelHistory(worker, token, channelId);
    const message = payload.messages.find(predicate);
    if (message) return message;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  agentInstanceWsUrl,
  connectTestAgentFixture,
  humanWsUrl,
  machineDaemonWsUrl,
  mintMachineDaemonCredential,
  openWebSocket,
  rememberTestMachineDaemon,
  requestTestConnectionCommand,
  startHubWorker,
  waitForClose,
  assert,
  randomUUID,
  test,
  MOCK_TOKEN,
  makeInbox,
  connectAgent,
  registerAgent,
  connectUser,
  json,
  postChannelMessage,
  channelHistory,
  mintAgentRunToken,
  connectSpawnedMockAgent,
  runAgentConnection,
  waitForChannelHistoryMessage,
  sleep,
};
