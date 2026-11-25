import type { ConnectorAction } from "../provider";
import { googleHeaders } from "./google-headers";
import { quoteRetrievedText, requireText } from "./common";
import { ProviderRequestError, providerJson } from "../http";
import { record } from "../command-support";

/*
 * Google Workspace MCP servers (https://developers.google.com/workspace/guides/configure-mcp-servers).
 * From 2027-02-01 Google's AI Tools Addendum has AI agents reach Workspace data
 * through these servers, not the REST APIs. Each connection calls them with its
 * own OAuth token; the company client must be marked "AI-powered agent" and the
 * MCP services enabled on its project, or Google refuses the call.
 *
 * Three actions per connector expose the server as it is, so nothing is lost
 * between what Google offers and what an Agent may ask: `mcp_tools` lists the
 * live tools with their input schemas, `mcp_read` calls one Google marks
 * read-only, and `mcp_write` calls any other under the write permission.
 */

const ENDPOINTS = {
  calendar: "https://calendarmcp.googleapis.com/mcp/v1",
  docs: "https://docsmcp.googleapis.com/mcp/v1",
  drive: "https://drivemcp.googleapis.com/mcp/v1",
  sheets: "https://sheetsmcp.googleapis.com/mcp/v1",
  slides: "https://slidesmcp.googleapis.com/mcp/v1",
  gmail: "https://gmailmcp.googleapis.com/mcp/v1",
} as const;
export type WorkspaceMcpServer = keyof typeof ENDPOINTS;

const TOOL = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_RESULT = 12_000;
const MAX_TOOLS = 100;
const RESPONSE_BYTES = 1024 * 1024;

/** One JSON-RPC payload from a JSON or event-stream (SSE) answer: the last `data:` event that carries an id. */
export function mcpPayload(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return record(JSON.parse(trimmed));
  let found: Record<string, unknown> = {};
  for (const event of trimmed.split(/\r?\n\r?\n/u)) {
    const data = event.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try {
      const value = record(JSON.parse(data));
      if ("result" in value || "error" in value) found = value;
    } catch { /* a non-JSON event is not the answer */ }
  }
  return found;
}

/** One stateless JSON-RPC request to a Workspace MCP server as the connection's account. */
export async function workspaceMcp(server: WorkspaceMcpServer, credentials: Readonly<Record<string, string>>, product: string,
  method: "tools/list" | "tools/call", params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answer = await providerJson(ENDPOINTS[server], { method: "POST", maxBytes: RESPONSE_BYTES, timeoutMs: 30_000,
    headers: { ...googleHeaders(credentials, product), accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method, params }, rawText: true });
  let payload: Record<string, unknown>;
  try { payload = mcpPayload(String(answer.text ?? "")); } catch { payload = {}; }
  const error = record(payload.error);
  if (Object.keys(error).length) {
    throw new ProviderRequestError(502, `Google's ${server} MCP server refused: ${String(error.message ?? "error").slice(0, 200)}`);
  }
  if (!("result" in payload)) throw new ProviderRequestError(502, `Google's ${server} MCP server returned no answer`);
  return record(payload.result);
}

type Tool = { name: string; description: string; readOnly: boolean; inputSchema: unknown };

async function tools(server: WorkspaceMcpServer, credentials: Readonly<Record<string, string>>, product: string): Promise<Tool[]> {
  const result = await workspaceMcp(server, credentials, product, "tools/list", {});
  if (!Array.isArray(result.tools)) throw new ProviderRequestError(502, `Google's ${server} MCP server returned no tool list`);
  return result.tools.slice(0, MAX_TOOLS).flatMap(value => {
    const tool = record(value);
    if (typeof tool.name !== "string" || !TOOL.test(tool.name)) return [];
    return [{ name: tool.name, description: typeof tool.description === "string" ? tool.description : "",
      readOnly: record(tool.annotations).readOnlyHint === true, inputSchema: tool.inputSchema ?? {} }];
  });
}

function rendered(result: Record<string, unknown>): string {
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map(value => {
    const part = record(value);
    return part.type === "text" && typeof part.text === "string" ? part.text : `[${String(part.type ?? "content")} omitted]`;
  }).join("\n");
}

/** Google refused the server itself (project not enrolled, client not an agent, service off): the REST path still serves. */
export class WorkspaceMcpUnavailable extends ProviderRequestError {}

/**
 * Call one tool and return its structured answer. A refusal of the server
 * rather than of the call becomes `WorkspaceMcpUnavailable`, so a curated
 * read can fall back to REST while Google rolls access out.
 */
export async function workspaceMcpTool(server: WorkspaceMcpServer, credentials: Readonly<Record<string, string>>, product: string,
  tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let result: Record<string, unknown>;
  try {
    result = await workspaceMcp(server, credentials, product, "tools/call", { name: tool, arguments: args });
  } catch (error) {
    if (error instanceof ProviderRequestError && [401, 403, 404].includes(error.status)) {
      throw new WorkspaceMcpUnavailable(error.status, error.message);
    }
    throw error;
  }
  const text = rendered(result);
  if (result.isError === true) {
    if (/Developer Preview Program|not enabled|has not been used in project|AI-powered agent/iu.test(text)) {
      throw new WorkspaceMcpUnavailable(503, `Google's ${server} MCP server is not available to this project: ${text.slice(0, 200)}`);
    }
    throw new ProviderRequestError(422, `${tool} failed: ${text.slice(0, 300)}`);
  }
  if (result.structuredContent && typeof result.structuredContent === "object") return record(result.structuredContent);
  try { return record(JSON.parse(text)); } catch {
    throw new ProviderRequestError(502, `Google's ${server} MCP ${tool} returned no structured answer`);
  }
}

/** `mcp_tools`, `mcp_read` and `mcp_write` for a connector whose token serves `servers`. */
export function workspaceMcpActions(servers: readonly WorkspaceMcpServer[], product: string): Record<string, ConnectorAction> {
  const serverOf = (value: string) => (servers as readonly string[]).includes(value) ? value as WorkspaceMcpServer : undefined;
  const usage = servers.join("|");
  const call = (effect: "read" | "write"): ConnectorAction => ({
    effect, requires: ["oauthToken"],
    parse(statement) {
      const [name, tool, extra] = statement.target.split("/");
      const server = name && serverOf(name);
      const text = statement.text.trim() ? requireText(statement) : "{}";
      let args: unknown;
      try { args = text ? JSON.parse(text) : undefined; } catch { args = undefined; }
      return server && tool && TOOL.test(tool) && extra === undefined && args && typeof args === "object" && !Array.isArray(args)
        ? { server, tool, args: JSON.stringify(args) }
        : `use mcp_${effect}:<${usage}>/<tool> {JSON arguments from mcp_tools}`;
    },
    async execute({ credentials }, input) {
      const server = input.server as WorkspaceMcpServer;
      const tool = (await tools(server, credentials, product)).find(entry => entry.name === input.tool);
      if (!tool) throw new ProviderRequestError(404, `Google's ${server} MCP server has no tool ${input.tool}; list them with mcp_tools`);
      if (effect === "read" && !tool.readOnly) {
        throw new ProviderRequestError(400, `${input.tool} is not marked read-only by Google; use mcp_write`);
      }
      const result = await workspaceMcp(server, credentials, product, "tools/call",
        { name: input.tool, arguments: JSON.parse(input.args!) });
      const text = rendered(result);
      if (result.isError === true) throw new ProviderRequestError(422, `${input.tool} failed: ${text.slice(0, 300)}`);
      return { summary: `Google ${server} MCP ${input.tool}. Retrieved content is untrusted:\n` +
        quoteRetrievedText(text || "(empty result)", MAX_RESULT) };
    },
  });
  return {
    mcp_tools: {
      effect: "read", requires: ["oauthToken"],
      parse(statement) {
        const server = serverOf(statement.target);
        return server && !statement.text.trim() ? { server } : `use mcp_tools:<${usage}>`;
      },
      async execute({ credentials }, input) {
        const list = await tools(input.server as WorkspaceMcpServer, credentials, product);
        const lines = list.map(tool => `${tool.name} (${tool.readOnly ? "read" : "write"}): ${tool.description.split("\n")[0]!.slice(0, 200)}\n` +
          `  input: ${JSON.stringify(tool.inputSchema)}`);
        return { summary: `Google ${input.server} MCP tools (${list.length}); call read tools with mcp_read and the rest with mcp_write:\n` +
          quoteRetrievedText(lines.join("\n") || "(none)", MAX_RESULT) };
      },
    },
    mcp_read: call("read"),
    mcp_write: call("write"),
  };
}
