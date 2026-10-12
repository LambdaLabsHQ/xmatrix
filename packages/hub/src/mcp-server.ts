import { ControlError, PostgresPageRepository } from "@xmatrix/db";
import type { McpCaller } from "./auth";
import { readChannelCatalogForPrincipal } from "./channel-catalog-read";
import { channelMessageHistory, channelMessageResult } from "./channel-messages";
import { appOrigin } from "./deployment-origins";
import { pageDatabaseOptions } from "./index-routes-pages";
import { McpToolError, serveMcp, type McpTool, type McpToolResult } from "./mcp-jsonrpc";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { runPrincipalOf } from "./run-principal";
import { listSpaces } from "./spaces";
import type { Env } from "./types";

/**
 * The Hub's MCP server for outside AI apps (docs/design/mcp-server.md): a
 * person's Spaces, pages and channels, read with exactly the access they have
 * in xMatrix. The caller is the person an OAuth access token names; the
 * granted scopes decide which tools exist.
 */

const HISTORY_LIMIT = 50;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const id = (description: string) => ({ type: "string", description, minLength: 1, maxLength: 300 });

const READ_TOOLS: McpTool[] = [
  {
    name: "list_spaces", title: "List Spaces", annotations: READ_ONLY,
    description: "The xMatrix Spaces (team workspaces) you belong to, with their ids. Start here to find a spaceId.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_pages", title: "List pages", annotations: READ_ONLY,
    description: "The page tree of a Space: every page you can read, with its id, title and parent.",
    inputSchema: { type: "object", properties: { spaceId: id("The Space, from list_spaces.") },
      required: ["spaceId"], additionalProperties: false },
  },
  {
    name: "search_pages", title: "Search pages", annotations: READ_ONLY,
    description: "Find pages in a Space by words in their title or current text; returns matching sections with snippets.",
    inputSchema: { type: "object", properties: { spaceId: id("The Space, from list_spaces."),
      query: { type: "string", description: "Words to look for.", minLength: 1, maxLength: 200 } },
    required: ["spaceId", "query"], additionalProperties: false },
  },
  {
    name: "read_page", title: "Read a page", annotations: READ_ONLY,
    description: "A page's current Markdown text, title and revision. `page:<id>` in the text refers to another page.",
    inputSchema: { type: "object", properties: { spaceId: id("The Space, from list_spaces."), pageId: id("The page.") },
      required: ["spaceId", "pageId"], additionalProperties: false },
  },
  {
    name: "list_channels", title: "List channels", annotations: READ_ONLY,
    description: "The channels (conversations) of a Space you can read, with their ids and names.",
    inputSchema: { type: "object", properties: { spaceId: id("The Space, from list_spaces.") },
      required: ["spaceId"], additionalProperties: false },
  },
  {
    name: "read_channel", title: "Read a channel", annotations: READ_ONLY,
    description: `The latest messages of a channel, oldest first (at most ${HISTORY_LIMIT}).`,
    inputSchema: { type: "object", properties: { channelId: id("The channel, from list_channels."),
      limit: { type: "integer", minimum: 1, maximum: HISTORY_LIMIT, description: "How many recent messages." } },
    required: ["channelId"], additionalProperties: false },
  },
];

function text(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

/** A refusal the Hub answered with: the model hears why; an outage stays an error. */
async function refused(response: Response): Promise<never> {
  const reason = (await response.json().catch(() => ({})) as { error?: string }).error;
  if (response.status < 500) throw new McpToolError(reason ?? "Not allowed");
  throw new Error(reason ?? `xMatrix answered ${response.status}`);
}

function argument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new McpToolError(`${name} is required`);
  return value.trim();
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = record(value);
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined && source[key] !== null)
    .map((key) => [key, source[key]]));
}

export function mcpServer(env: Env, caller: McpCaller) {
  const principal = runPrincipalOf(caller.user);
  const pages = () => new PostgresPageRepository(createPostgresAuthorityDatabase(env, pageDatabaseOptions));
  const pageLink = (spaceId: string, pageId: string) =>
    `${appOrigin(env)}/app/${encodeURIComponent(spaceId)}/pages?page=${encodeURIComponent(pageId)}`;
  const requestId = () => crypto.randomUUID();
  const readable = caller.scopes.includes("xmatrix:read");

  const calls: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
    list_spaces: async () => text({ spaces: (await listSpaces(env, { kind: "user", id: caller.user.id }))
      .map((space) => pick(space, ["id", "name", "description"])) }),
    list_pages: async (args) => {
      const spaceId = argument(args, "spaceId");
      const { pages: tree } = await pages().tree({ requestId: requestId(), spaceId, principal });
      return text({ pages: tree.map((page) => ({ pageId: page.pageId, parentPageId: page.parentPageId, title: page.title,
        updatedAt: page.updatedAt, url: pageLink(spaceId, page.pageId) })) });
    },
    search_pages: async (args) => {
      const spaceId = argument(args, "spaceId");
      const { results } = await pages().search({ requestId: requestId(), spaceId, principal,
        query: argument(args, "query") });
      return text({ results: results.map((hit) => ({ ...hit, url: pageLink(spaceId, hit.pageId) })) });
    },
    read_page: async (args) => {
      const spaceId = argument(args, "spaceId");
      const pageId = argument(args, "pageId");
      const { page } = await pages().read({ requestId: requestId(), spaceId, pageId, principal });
      return text({ pageId, title: page.title, revision: page.headRevision, url: pageLink(spaceId, pageId), body: page.body });
    },
    list_channels: async (args) => {
      const catalog = await readChannelCatalogForPrincipal(env, { kind: "user", id: caller.user.id }, argument(args, "spaceId"));
      if (!catalog.ok) return refused(catalog.response);
      return text({ channels: catalog.channels.map((channel) => pick(channel, ["id", "name", "topic", "spaceId", "mode"])) });
    },
    read_channel: async (args) => {
      const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), HISTORY_LIMIT) : HISTORY_LIMIT;
      const channelId = argument(args, "channelId");
      const read = await channelMessageResult(() => channelMessageHistory(env, { channelId, limit,
        principal: { kind: "user", id: caller.user.id } }));
      if (!read.ok) return refused(read.response);
      const history = read.payload;
      const messages = Array.isArray(history.messages) ? history.messages : [];
      return text({ messages: messages.map((message) => ({
        ...pick(message, ["messageId", "body", "sentAt", "replyToMessageId"]),
        from: pick(record(message).from, ["label", "kind"]),
      })) });
    },
  };

  return serveMcp.bind(null, {
    name: "xmatrix",
    instructions: "xMatrix is where a team and its AI agents work together: Spaces hold pages (living documents of " +
      "how things stand) and channels (conversations). Find a Space with list_spaces, then read its pages and channels.",
    tools: async () => readable ? READ_TOOLS : [],
    call: async (name, args) => {
      const call = readable ? calls[name] : undefined;
      if (!call) return null;
      try {
        return await call(args);
      } catch (failure) {
        if (failure instanceof ControlError && failure.status < 500) throw new McpToolError(failure.message);
        throw failure;
      }
    },
  });
}
