import { ControlError, PostgresPageRepository } from "@xmatrix/db";
import type { McpCaller } from "./auth";
import { readChannelCatalogForPrincipal } from "./channel-catalog-read";
import { channelMessageHistory, channelMessageResult } from "./channel-messages";
import { appOrigin, hubAuthBaseUrl } from "./deployment-origins";
import { pageDatabaseOptions } from "./index-routes-pages";
import { McpToolError, serveMcp, type McpTool, type McpToolResult } from "./mcp-jsonrpc";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { runPrincipalOf } from "./run-principal";
import { listSpaces } from "./spaces";
import { asInternalCaller } from "./internal-caller";
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

const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const WRITE_TOOLS: McpTool[] = [
  {
    name: "create_page", title: "Create a page", annotations: WRITES,
    description: "Add a page to a Space, as you. Its text is Markdown; refer to another page with `page:<id>`.",
    inputSchema: { type: "object", properties: { spaceId: id("The Space, from list_spaces."),
      title: { type: "string", minLength: 1, maxLength: 200 },
      body: { type: "string", maxLength: 200_000, description: "The page's Markdown text." },
      parentPageId: id("The page to put it below; omit for the top level.") },
    required: ["spaceId", "title"], additionalProperties: false },
  },
  {
    name: "edit_page", title: "Edit a page", annotations: { ...WRITES, destructiveHint: true },
    description: "Replace a page's text with your new version of the revision you read (read_page gives the " +
      "revision). Edits made by others meanwhile are merged; if yours overlaps them, read the page again and redo it.",
    inputSchema: { type: "object", properties: { spaceId: id("The Space."), pageId: id("The page."),
      baseRevision: { type: "integer", minimum: 1, description: "The revision your text is based on." },
      body: { type: "string", maxLength: 200_000, description: "The page's whole new Markdown text." } },
    required: ["spaceId", "pageId", "baseRevision", "body"], additionalProperties: false },
  },
  {
    name: "send_message", title: "Send a message", annotations: WRITES,
    description: "Post a message in a channel, as you. Mentioning an Agent (@name) asks it to act, as it would " +
      "if you typed the message in xMatrix.",
    inputSchema: { type: "object", properties: { channelId: id("The channel, from list_channels."),
      body: { type: "string", minLength: 1, maxLength: 20_000 },
      replyToMessageId: id("A message to reply to.") },
    required: ["channelId", "body"], additionalProperties: false },
  },
];

function text(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

/** A refusal the Hub answered with: the model hears why; an outage stays an error. */
async function refused(response: Response): Promise<never> {
  const refusal = await response.json().catch(() => ({})) as { error?: string; code?: string; detail?: unknown };
  const reason = refusal.error;
  // An overlapping edit carries the current text, so the model can redo its change on it.
  if (refusal.code === "page_revision_conflict") {
    throw new McpToolError(`${reason ?? "The page changed"}. Current page: ${JSON.stringify(refusal.detail)}`);
  }
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

/**
 * `dispatch` runs a request through the Hub's own routes: writing tools act
 * through them as the person, so a message or an edit from an outside app is
 * the same act, with the same checks and effects, as one made in xMatrix.
 */
export function mcpServer(env: Env, caller: McpCaller, dispatch: (request: Request) => Promise<Response>) {
  const principal = runPrincipalOf(caller.user);
  const pages = () => new PostgresPageRepository(createPostgresAuthorityDatabase(env, pageDatabaseOptions));
  const pageLink = (spaceId: string, pageId: string) =>
    `${appOrigin(env)}/app/${encodeURIComponent(spaceId)}/pages?page=${encodeURIComponent(pageId)}`;
  const requestId = () => crypto.randomUUID();
  const readable = caller.scopes.includes("xmatrix:read");
  const writable = readable && caller.scopes.includes("xmatrix:write");
  /** One of the Hub's routes, called as the person; its refusal is the tool's. */
  const route = async (method: string, path: string, body: Record<string, unknown>) => {
    const response = await asInternalCaller(caller.user, (headers) => dispatch(new Request(
      new URL(path, hubAuthBaseUrl(env)), { method, headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body) })));
    if (!response.ok) return refused(response);
    return await response.json() as Record<string, unknown>;
  };
  const pagesPath = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/pages`;

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

  const writes: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
    create_page: async (args) => {
      const spaceId = argument(args, "spaceId");
      const { page } = await route("POST", pagesPath(spaceId), { title: argument(args, "title"),
        ...(typeof args.body === "string" ? { body: args.body } : {}),
        ...(typeof args.parentPageId === "string" ? { parentPageId: args.parentPageId } : {}) });
      const created = record(page);
      return text({ pageId: created.pageId, revision: created.headRevision,
        url: pageLink(spaceId, String(created.pageId)) });
    },
    edit_page: async (args) => {
      const spaceId = argument(args, "spaceId");
      const pageId = argument(args, "pageId");
      if (typeof args.baseRevision !== "number" || typeof args.body !== "string") {
        throw new McpToolError("baseRevision and body are required");
      }
      const edited = await route("PUT", `${pagesPath(spaceId)}/${encodeURIComponent(pageId)}`,
        { baseRevision: args.baseRevision, body: args.body });
      return text({ pageId, revision: edited.headRevision, url: pageLink(spaceId, pageId) });
    },
    send_message: async (args) => {
      const channelId = argument(args, "channelId");
      const sent = await route("POST", `/api/channels/${encodeURIComponent(channelId)}/messages`, {
        body: argument(args, "body"),
        ...(typeof args.replyToMessageId === "string" ? { replyToMessageId: args.replyToMessageId } : {}),
      });
      return text(pick(sent.message, ["messageId", "channelId", "sentAt"]));
    },
  };

  return serveMcp.bind(null, {
    name: "xmatrix",
    instructions: "xMatrix is where a team and its AI agents work together: Spaces hold pages (living documents of " +
      "how things stand) and channels (conversations). Find a Space with list_spaces, then read its pages and channels.",
    tools: async () => [...(readable ? READ_TOOLS : []), ...(writable ? WRITE_TOOLS : [])],
    call: async (name, args) => {
      const call = (readable ? calls[name] : undefined) ?? (writable ? writes[name] : undefined);
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
