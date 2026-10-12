import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "@xmatrix/protocol";
import type { Env } from "../types";
import { runConnectorAction } from "./connector-commands";
import { connectorProvider } from "./registry";
import { connectorActionCatalog } from "./action-catalog";
import { listAppConnections } from "../apps";
import { serveMcp, type McpTool } from "../mcp-jsonrpc";

/*
 * Connector actions as MCP tools for an Agent Run (docs/design/connector-platform.md
 * §3.5): `POST /api/connectors/mcp`, JSON-RPC over streamable HTTP without
 * server-sent streams. A tool call is the same execution as the Agent posting
 * `@<provider>:<action>:<target> <text>` in its Run's Channel: the Channel's
 * policy applies (an Agent's write needs `allow`), and the receipt is posted
 * there.
 */

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
function tools(connected: ReadonlySet<string>): McpTool[] {
  return APP_CONNECTOR_PROVIDER_MANIFESTS.filter((manifest) => connected.has(manifest.id)).flatMap((manifest) =>
    [...connectorActionCatalog(manifest.id, connectorProvider(manifest.id)?.actions).values()]
    .map(({ definition: action }) => ({
      name: `${manifest.id}__${action.id}`,
      title: `${manifest.name}: ${action.label}`,
      description: `${action.description} Runs in your Channel with ${manifest.name} connected to the Space; ` +
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

export async function handleConnectorMcp(env: Env, caller: ConnectorMcpCaller, body: unknown,
  run: typeof runConnectorAction = runConnectorAction,
  connected: typeof connectedConnectorProviders = connectedConnectorProviders): Promise<Response> {
  return serveMcp({
    name: "xmatrix-connectors",
    tools: async () => tools(await connected(env, caller)),
    call: async (name, args) => {
      const match = name.match(TOOL_NAME);
      const provider = match ? connectorProvider(match[1]!) : undefined;
      const action = provider && match ? connectorActionCatalog(provider.id, provider.actions).get(match[2]!)?.executor : undefined;
      if (!match || !provider || !action) return null;
      const target = typeof args.target === "string" ? args.target.trim() : "";
      const text = typeof args.text === "string" ? args.text.trim() : "";
      const line = await run(provider.id, {
        env, channelId: caller.channelId, messageId: `mcp:${caller.runId}:${crypto.randomUUID()}`,
        body: `@${provider.id}:${match[2]}:${target} ${text}`.trim(), actorUserId: caller.ownerUserId, senderKind: "agent",
      }, match[2]!, action, { target, text });
      return { content: [{ type: "text", text: line }], isError: !/: completed;/u.test(line) };
    },
  }, body);
}
