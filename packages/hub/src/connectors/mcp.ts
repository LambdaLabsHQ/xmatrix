import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "@xmatrix/protocol";
import type { Env } from "../types";
import { runConnectorAction } from "./connector-commands";
import { connectorProvider } from "./registry";
import { listAppConnections } from "../apps";

/*
 * Connector actions as MCP tools for an Agent Run (docs/design/connector-platform.md
 * §3.5): `POST /api/connectors/mcp`, JSON-RPC over streamable HTTP without
 * server-sent streams. A tool call is the same execution as the Agent posting
 * `@<provider>:<action>:<target> <text>` in its Run's Channel: the Channel's
 * policy applies (an Agent's write needs `allow`), and the receipt is posted
 * there.
 */

const PROTOCOL_VERSION = "2025-06-18";
const TOOL_NAME = /^([a-z][a-z0-9-]*)__([a-z_]+)$/u;

export interface ConnectorMcpCaller {
  ownerUserId: string;
  channelId: string;
  runId: string;
  spaceId: string;
}

/** The providers the Run's Space has a configured connection for. */
export async function connectedConnectorProviders(env: Env, caller: ConnectorMcpCaller): Promise<Set<string>> {
  const listed = await listAppConnections(env, { spaceId: caller.spaceId, actorUserId: caller.ownerUserId });
  return new Set(listed.flatMap((item) => {
    const connection = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return connection.status === "configured" && typeof connection.providerId === "string" ? [connection.providerId] : [];
  }));
}

/* Only the Space's connected providers: a tool the Run could only learn is
   unusable by calling it is noise in every harness's tool list. */
function tools(connected: ReadonlySet<string>) {
  return APP_CONNECTOR_PROVIDER_MANIFESTS.filter((manifest) => connected.has(manifest.id)).flatMap((manifest) => manifest.actions
    .filter((action) => action.effect && connectorProvider(manifest.id)?.actions?.[action.id])
    .map((action) => ({
      name: `${manifest.id}__${action.id}`,
      title: `${manifest.name}: ${action.label}`,
      description: `${action.description} Runs in your Channel with ${manifest.name} connected to the Space; ` +
        `${action.effect === "write" && action.defaultPolicy !== "allow" ? `needs @${manifest.id}:policy:${action.id} allow from a Space admin. ` : ""}` +
        `Usage: @${manifest.id}:${action.id}:${action.usage ?? "<target> <text>"}`,
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "What the action applies to, the part after the action in its usage." },
          text: { type: "string", description: "The text the action posts or writes, if it takes any." },
        },
        required: ["target"],
        additionalProperties: false,
      },
    })));
}

function result(id: unknown, value: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result: value });
}

function error(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function handleConnectorMcp(env: Env, caller: ConnectorMcpCaller, body: unknown,
  run: typeof runConnectorAction = runConnectorAction,
  connected: typeof connectedConnectorProviders = connectedConnectorProviders): Promise<Response> {
  const request = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const { id, method } = request;
  const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  if (request.jsonrpc !== "2.0" || typeof method !== "string") return error(id ?? null, -32600, "Invalid Request");
  if (id === undefined) return new Response(null, { status: 202 });
  if (method === "initialize") {
    return result(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "xmatrix-connectors", version: "1" } });
  }
  if (method === "ping") return result(id, {});
  if (method === "tools/list") {
    try {
      return result(id, { tools: tools(await connected(env, caller)) });
    } catch (failure) {
      return error(id, -32603, failure instanceof Error ? failure.message : "connector connections are unavailable");
    }
  }
  if (method !== "tools/call") return error(id, -32601, "Method not found");
  const match = typeof params.name === "string" ? params.name.match(TOOL_NAME) : null;
  const provider = match ? connectorProvider(match[1]!) : undefined;
  const action = match ? provider?.actions?.[match[2]!] : undefined;
  if (!match || !provider || !action) return error(id, -32602, "Unknown tool");
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  const target = typeof args.target === "string" ? args.target.trim() : "";
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const line = await run(provider.id, {
    env, channelId: caller.channelId, messageId: `mcp:${caller.runId}:${crypto.randomUUID()}`,
    body: `@${provider.id}:${match[2]}:${target} ${text}`.trim(), actorUserId: caller.ownerUserId, senderKind: "agent",
  }, match[2]!, action, { target, text });
  return result(id, { content: [{ type: "text", text: line }], isError: !/: completed;/u.test(line) });
}
