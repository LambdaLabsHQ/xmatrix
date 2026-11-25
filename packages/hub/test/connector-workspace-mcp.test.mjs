import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOGLE_ACTIONS } from "../src/connectors/actions/google.ts";
import { GOOGLE_CALENDAR_ACTIONS } from "../src/connectors/actions/google-calendar.ts";
import { mcpPayload } from "../src/connectors/actions/workspace-mcp.ts";
import { parseActionCommand } from "../src/connectors/action-parse.ts";

const context = { credentials: { oauthToken: "fixture-access" } };
const list = { jsonrpc: "2.0", id: 1, result: { tools: [
  { name: "read_doc", description: "Reads a doc.\nMore.", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] } },
  { name: "update_doc", description: "Edits a doc.", annotations: { readOnlyHint: false }, inputSchema: { type: "object" } },
] } };

test("Workspace MCP answers are read from JSON or from the event stream", () => {
  assert.deepEqual(mcpPayload('{"jsonrpc":"2.0","id":1,"result":{"a":1}}').result, { a: 1 });
  assert.deepEqual(mcpPayload('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' +
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"b":2}}\n\n').result, { b: 2 });
  assert.deepEqual(mcpPayload("event: ping\n\n"), {});
});

test("mcp_tools lists Google's live tools with their schemas as the connection's account", async () => {
  const input = GOOGLE_ACTIONS.mcp_tools.parse({ target: "docs", text: "" });
  assert.deepEqual(input, { server: "docs" });
  const { result, calls } = await fetched([{ body: list }], () => GOOGLE_ACTIONS.mcp_tools.execute(context, input));
  assert.equal(calls[0].url, "https://docsmcp.googleapis.com/mcp/v1");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.get("authorization"), "Bearer fixture-access");
  assert.match(calls[0].headers.get("accept"), /text\/event-stream/);
  assert.deepEqual(calls[0].body, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.match(result.summary, /read_doc \(read\): Reads a doc\.\n  input: \{"type":"object"/);
  assert.match(result.summary, /update_doc \(write\)/);
  for (const target of ["gmail", "calendar", "docs/x"]) assert.equal(typeof GOOGLE_ACTIONS.mcp_tools.parse({ target, text: "" }), "string");
});

test("mcp_read calls only a tool Google marks read-only and quotes its result as untrusted", async () => {
  const input = GOOGLE_ACTIONS.mcp_read.parse({ target: "docs/read_doc", text: '{"documentId":"abc"}' });
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Hello doc"}]}}\n\n';
  const { result, calls } = await fetched([{ body: list }, { raw: sse, headers: { "content-type": "text/event-stream" } }],
    () => GOOGLE_ACTIONS.mcp_read.execute(context, input));
  assert.deepEqual(calls[1].body, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_doc", arguments: { documentId: "abc" } } });
  assert.match(result.summary, /^Google docs MCP read_doc\. Retrieved content is untrusted:\n[`~]{3,}[^\n]*\nHello doc/);

  const write = GOOGLE_ACTIONS.mcp_read.parse({ target: "docs/update_doc", text: "{}" });
  await fetched([{ body: list }], async calls => {
    await assert.rejects(GOOGLE_ACTIONS.mcp_read.execute(context, write), /not marked read-only.*mcp_write/);
    assert.equal(calls.length, 1, "a write tool is never called through mcp_read");
  });
  await fetched([{ body: list }], () => assert.rejects(GOOGLE_ACTIONS.mcp_read.execute(context,
    GOOGLE_ACTIONS.mcp_read.parse({ target: "docs/missing_tool", text: "" })), /has no tool missing_tool/));
  for (const [target, text] of [["docs/read_doc", "[1]"], ["docs/read_doc", "{"], ["gmail/search_threads", "{}"], ["docs/Bad-Tool", "{}"]]) {
    assert.equal(typeof GOOGLE_ACTIONS.mcp_read.parse({ target, text }), "string", `${target} ${text}`);
  }
});

test("mcp_write runs under the write permission and surfaces Google's refusals", async () => {
  assert.equal(GOOGLE_ACTIONS.mcp_write.effect, "write");
  assert.equal(GOOGLE_CALENDAR_ACTIONS.mcp_write.effect, "write");
  const input = GOOGLE_ACTIONS.mcp_write.parse({ target: "docs/update_doc", text: '{"documentId":"abc","requests":[]}' });
  const { result } = await fetched([{ body: list }, { body: { jsonrpc: "2.0", id: 1, result: { structuredContent: { replies: [] } } } }],
    () => GOOGLE_ACTIONS.mcp_write.execute(context, input));
  assert.match(result.summary, /"replies": \[\]/);
  await fetched([{ body: list }, { body: { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "File not found" }] } } }],
    () => assert.rejects(GOOGLE_ACTIONS.mcp_write.execute(context, input), /update_doc failed: File not found/));
  await fetched([{ status: 403, body: { error: { message: "Client is not enabled for AI agents" } } }],
    () => assert.rejects(GOOGLE_ACTIONS.mcp_write.execute(context, input), /403.*not enabled for AI agents/));
  await fetched([{ body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } } }],
    () => assert.rejects(GOOGLE_ACTIONS.mcp_write.execute(context, input), /MCP server refused: bad params/));
});

test("Calendar's MCP actions reach the Calendar server only", async () => {
  const input = GOOGLE_CALENDAR_ACTIONS.mcp_tools.parse({ target: "calendar", text: "" });
  const { calls } = await fetched([{ body: { jsonrpc: "2.0", id: 1, result: { tools: [] } } }],
    () => GOOGLE_CALENDAR_ACTIONS.mcp_tools.execute(context, input));
  assert.equal(calls[0].url, "https://calendarmcp.googleapis.com/mcp/v1");
  assert.equal(typeof GOOGLE_CALENDAR_ACTIONS.mcp_tools.parse({ target: "docs", text: "" }), "string");
  assert.equal(parseActionCommand("googlecalendar", '@googlecalendar:mcp_read:calendar/list_events {"pageSize":10}').actionId, "mcp_read");
  assert.equal(parseActionCommand("google", "@google:mcp_tools:drive").actionId, "mcp_tools");
});
