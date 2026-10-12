/**
 * The JSON-RPC side of an MCP server over streamable HTTP without
 * server-sent streams: what the Hub's MCP endpoints share. Each endpoint
 * names its server and supplies its tools; authorization stays with it.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface McpToolResult { content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: unknown }

/** A tool call that cannot run as asked; its message goes back to the model. */
export class McpToolError extends Error {}

export interface McpServer {
  name: string;
  instructions?: string;
  tools: () => Promise<McpTool[]>;
  call: (name: string, args: Record<string, unknown>) => Promise<McpToolResult | null>;
}

function result(id: unknown, value: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result: value });
}

function error(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function serveMcp(server: McpServer, body: unknown): Promise<Response> {
  const request = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const { id, method } = request;
  const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  if (request.jsonrpc !== "2.0" || typeof method !== "string") return error(id ?? null, -32600, "Invalid Request");
  if (id === undefined) return new Response(null, { status: 202 });
  if (method === "initialize") {
    return result(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: server.name, version: "1" }, ...(server.instructions ? { instructions: server.instructions } : {}) });
  }
  if (method === "ping") return result(id, {});
  if (method === "tools/list") {
    try {
      return result(id, { tools: await server.tools() });
    } catch (failure) {
      return error(id, -32603, failure instanceof Error ? failure.message : "tools are unavailable");
    }
  }
  if (method !== "tools/call") return error(id, -32601, "Method not found");
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown> : {};
  try {
    const outcome = typeof params.name === "string" ? await server.call(params.name, args) : null;
    return outcome ? result(id, outcome) : error(id, -32602, "Unknown tool");
  } catch (failure) {
    if (failure instanceof McpToolError) return result(id, { content: [{ type: "text", text: failure.message }], isError: true });
    throw failure;
  }
}
