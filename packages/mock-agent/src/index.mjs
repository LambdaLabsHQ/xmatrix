#!/usr/bin/env node

const DEFAULT_HUB_URL = "http://localhost:8787";
const DEFAULT_TOKEN = "xmatrix-mock-token";
const HEARTBEAT_INTERVAL_MS = 10_000;

function parseArgs(argv) {
  const args = {
    hub: process.env.XMATRIX_HUB_URL || DEFAULT_HUB_URL,
    token: process.env.XMATRIX_MOCK_AUTH_TOKEN || DEFAULT_TOKEN,
    name: process.env.XMATRIX_MOCK_AGENT_NAME || "xmatrix-mock-agent",
    channel: process.env.XMATRIX_MOCK_CHANNEL || "#mock-channel",
    message: process.env.XMATRIX_MOCK_MESSAGE || "mock agent online",
    once: false,
    echo: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[index];
    };

    if (arg === "--hub") args.hub = next();
    else if (arg === "--token") args.token = next();
    else if (arg === "--name") args.name = next();
    else if (arg === "--channel") args.channel = next();
    else if (arg === "--message") args.message = next();
    else if (arg === "--once") args.once = true;
    else if (arg === "--no-echo") args.echo = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: xmatrix-mock-agent [options]

Options:
  --hub <url>        Hub HTTP URL. Default: ${DEFAULT_HUB_URL}
  --token <token>    Mock auth token. Default: ${DEFAULT_TOKEN}
  --name <name>      Agent name. Default: xmatrix-mock-agent
  --channel <name>   Channel to create or reuse. Default: #mock-channel
  --message <body>   Initial channel message. Default: mock agent online
  --once             Send initial message and exit
  --no-echo          Do not echo web channel messages
`);
}

function deriveAgentInstanceConnectionUrl(hubUrl) {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/agent-instances";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function createRequestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function normalizeChannelName(channel) {
  return channel.startsWith("#") ? channel : `#${channel}`;
}

async function waitForMessage(messages, predicate, timeoutMs, label) {
  const existingIndex = messages.findIndex(predicate);
  if (existingIndex >= 0) {
    const [message] = messages.splice(existingIndex, 1);
    return message;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);

    const listener = (message) => {
      if (!predicate(message)) {
        return;
      }
      cleanup();
      resolve(message);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      messages.off(listener);
    };

    messages.on(listener);
  });
}

function createMessageBuffer() {
  const items = [];
  const listeners = new Set();
  return {
    push(message) {
      items.push(message);
      for (const listener of listeners) {
        listener(message);
      }
    },
    findIndex(predicate) {
      return items.findIndex(predicate);
    },
    splice(index, count) {
      return items.splice(index, count);
    },
    on(listener) {
      listeners.add(listener);
    },
    off(listener) {
      listeners.delete(listener);
    },
  };
}

async function request(ws, messages, payload, expectedType, timeoutMs = 5000) {
  const requestId = payload.requestId || createRequestId(payload.type);
  send(ws, { ...payload, requestId });
  const response = await waitForMessage(
    messages,
    (message) =>
      message.requestId === requestId &&
      (message.type === expectedType || message.type === "error"),
    timeoutMs,
    expectedType
  );
  if (response.type === "error") {
    throw new Error(response.message || `Request failed: ${payload.type}`);
  }
  return response;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const channelName = normalizeChannelName(args.channel);
  const relayUrl = deriveAgentInstanceConnectionUrl(args.hub);
  const messages = createMessageBuffer();
  const ws = new WebSocket(relayUrl);

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error(`Failed to connect to ${relayUrl}`)),
      { once: true }
    );
  });

  ws.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      messages.push(message);

      if (args.echo && message.type === "channel_message_received") {
        send(ws, {
          type: "channel_message",
          channelId: message.channelId,
          body: `mock echo: ${message.body}`,
        });
      }
    } catch (error) {
      console.error("[mock-agent] failed to parse server message", error);
    }
  });

  ws.addEventListener("close", (event) => {
    console.log(
      JSON.stringify({
        type: "closed",
        code: event.code,
        reason: event.reason,
      })
    );
    if (!args.once) process.exit(event.code === 1000 ? 0 : 1);
  });

  send(ws, {
    type: "agent_instance_connect",
    token: args.token,
    name: args.name,
    runtime: { kind: "mock" },
    runContext: { mock: true, purpose: "e2e" },
  });

  const registered = await waitForMessage(
    messages,
    (message) => message.type === "agent_instance_connected" || message.type === "error",
    5000,
    "registered"
  );
  if (registered.type === "error") {
    throw new Error(registered.message || "Registration failed");
  }

  const channelList = await request(ws, messages, { type: "list_channels" }, "channel_list");
  const existing = channelList.channels.find(
    (channel) => channel.name === channelName
  );
  const channel = existing
    ? existing
    : (
        await request(
          ws,
          messages,
          {
            type: "create_channel",
            name: channelName,
            mode: "open",
            metadata: { mock: true, purpose: "e2e" },
          },
          "channel_created"
        )
      ).channel;

  if (args.message) {
    send(ws, {
      type: "channel_message",
      channelId: channel.id,
      body: args.message,
    });
  }

  console.log(
    JSON.stringify({
      type: "ready",
      hubUrl: args.hub,
      relayUrl,
      token: args.token,
      agent: registered.agent,
      channel,
    })
  );

  if (args.once) {
    await request(ws, messages, { type: "unregister" }, "unregistered").catch(() => {});
    ws.close(1000, "mock complete");
    return;
  }

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, { type: "ping", requestId: createRequestId("ping") });
    }
  }, HEARTBEAT_INTERVAL_MS);

  async function shutdown(reason) {
    clearInterval(heartbeat);
    if (ws.readyState === WebSocket.OPEN) {
      await request(ws, messages, { type: "unregister" }, "unregistered").catch(() => {});
    }
    ws.close(1000, reason);
  }

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

run().catch((error) => {
  console.error(`[mock-agent] ${error.message}`);
  process.exit(1);
});
