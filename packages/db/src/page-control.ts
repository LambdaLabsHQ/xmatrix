import type { QueryResultRow } from "pg";
import { LIVE_AGENT_STATUS_SQL, isLiveAgentStatus, pageBlockAt, pageBlocks, pageChangeGist, utf8ByteLength } from "@xmatrix/protocol";
import { canonicalPageMarkdown, pageChangedDocBlocks } from "@xmatrix/protocol/page-document";
import { readsOnly } from "./space-roles.js";
import { MessageAuthorityError } from "./message-authority-error.js";
import { ControlError } from "./control-error.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { channelCapabilityPredicate, requireChannelCapability } from "./channel-capability-policy.js";
import { loadChannelAgentPresence } from "./channel-agent-presence.js";
import { requireAgentChannelAccess, type AgentChannelRunProof } from "./agent-channel-access.js";
import { PostgresChannelSpaceDirectory, PostgresSpacePlacementDirectory } from "./placement.js";
import { reconcilePageAutomations, removePageAutomations } from "./automation-page-anchor.js";
import type {
  PageAuthor, PageAutomationAnchorChange, PageBlockAwareness, PageClaim, PageDocument, PageLink, PageLinkAnchor, PageOwedUpdate, PageRecentChange, PageRevision, PageSearchHit, PageSummary, PageTreeAgent, PublicPage,
} from "@xmatrix/protocol";

export type { PageAuthor, PageClaim, PageDocument, PageLink, PageRevision, PageSummary, PublicPage };

/**
 * Pages (docs/design/pages-and-conversations.md): the Space's hierarchy of
 * markdown documents describing the current state. This repository is the
 * page authority. Each page's content is a linear, immutable revision history
 * and the page row points at its head; a live co-editing session commits here
 * through `edit` against the revision it loaded, so a stale base is refused
 * rather than overwritten.
 *
 * Access: a page is governed by its nearest restricted ancestor-or-self. With
 * none, every Space member reads and every non-viewer edits. A restricted page
 * is readable by its `page_access` subjects and by Space owners/admins, and
 * editable by `edit` subjects and owners/admins. An Agent Run acts with its
 * owner's page access, and only while the Run itself is live in this Space.
 * Structure (create, move, rename, delete, access) is a human act.
 */

export type PagePrincipal =
  | { kind: "user"; id: string; label?: string }
  | { kind: "agent"; id: string; label?: string; runProof: AgentChannelRunProof };

export class PageControlError extends MessageAuthorityError {
  constructor(code: string, status: number, message = code, readonly detail?: Record<string, unknown>) {
    super(code, status, message);
  }
}

const MAX_PAGES = 5_000;
/** Ctrl+F lists at most this many page hits; the dialog has the same ceiling. */
const PAGE_SEARCH_RESULT_LIMIT = 80;
const PAGE_SEARCH_SNIPPET_CHARS = 160;
const MAX_GIT_REVISIONS = 5_000;
const MAX_DEPTH = 64;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_HISTORY = 200;
/** How long ended claimed work can leave its section owing an update. */
const OWED_WINDOW_DAYS = 7;
/** How far back a section's last change is looked for; older changes read as unknown. */
const BLOCK_UPDATE_REVISIONS = 30;
/** Recent changes the Pages list shows, and at most when asked for more. */
const RECENT_CHANGES = 3;
const MAX_RECENT_CHANGES = 10;
const RECENT_CHANGE_SPARES = 4;
const MAX_LINKS = 500;
const DEFAULT_CLAIM_MINUTES = 120;
const MAX_CLAIM_MINUTES = 24 * 60;
const MAX_CONVERSATION_PAGES = 20;
const BLOCK = /^[a-z0-9\p{L}\p{N}][a-z0-9\p{L}\p{N}_-]{0,199}$/u;

function bounded(value: unknown, field: string, max = 300): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new PageControlError("invalid_request", 400, `${field} is invalid`);
  }
  return value;
}

export function pageTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 200) {
    throw new PageControlError("invalid_page_title", 400, "A page title is 1-200 characters");
  }
  return value.trim();
}

export function pageBody(value: unknown): string {
  if (typeof value !== "string") throw new PageControlError("invalid_page_body", 400, "A page body is text");
  if (utf8ByteLength(value) > MAX_BODY_BYTES) {
    throw new PageControlError("page_body_too_large", 413, "A page is at most 256 KiB of markdown");
  }
  return value;
}

function pageSearchSnippet(text: string, at: number, length: number): string {
  const half = Math.floor((PAGE_SEARCH_SNIPPET_CHARS - length) / 2);
  const start = Math.max(0, at - Math.max(half, 0));
  const end = Math.min(text.length, start + PAGE_SEARCH_SNIPPET_CHARS);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

/** A title hit, or the section whose current text contains the query. Body wins when both match. */
function pageSearchHit(title: string, body: string, pageId: string, query: string): PageSearchHit {
  const needle = query.toLocaleLowerCase();
  const bodyAt = body.toLocaleLowerCase().indexOf(needle);
  if (bodyAt >= 0) {
    const blockId = pageBlockAt(body, bodyAt);
    const block = pageBlocks(body).find((item) => item.id === blockId);
    return {
      pageId, title, blockId, blockTitle: block?.title ?? "", field: "body",
      snippet: pageSearchSnippet(body, bodyAt, needle.length),
    };
  }
  return { pageId, title, blockId: "", blockTitle: "", field: "title", snippet: title };
}

function blockId(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !BLOCK.test(value)) {
    throw new PageControlError("invalid_block_id", 400, "A block id is a heading slug");
  }
  return value;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Between two sibling positions (either may be absent), a key that sorts strictly between them. */
export function pagePositionBetween(before: string | null, after: string | null): string {
  const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const lo = before ?? "";
  const hi = after ?? "";
  if (hi && lo >= hi) throw new PageControlError("invalid_page_position", 400, "positions are out of order");
  let result = "";
  for (let i = 0; ; i++) {
    const a = i < lo.length ? digits.indexOf(lo[i]!) : 0;
    const b = hi && i < hi.length ? digits.indexOf(hi[i]!) : digits.length;
    if (b - a > 1) return result + digits[Math.floor((a + b) / 2)]!;
    result += digits[a]!;
    if (result.length >= 99) throw new PageControlError("page_position_exhausted", 409);
  }
}

type PageRow = QueryResultRow & {
  page_id: string; parent_page_id: string | null; title: string; position: string;
  access_mode: "open" | "restricted"; head_revision: string | number; agent_suggest_only: boolean;
  updated_at: Date | string; version: string | number; published_at: Date | string | null;
};

type RevisionRow = QueryResultRow & {
  revision: string | number; kind: PageRevision["kind"]; body?: string;
  authors_json: PageAuthor[]; conversation_ids: string[]; based_on_revision: string | number | null;
  created_at: Date | string;
};

type LinkRow = QueryResultRow & {
  link_id: string; conversation_id: string; page_id: string; block_id: string;
  source: PageLink["source"]; created_at: Date | string; last_seen_at: Date | string;
  anchor_json: PageLinkAnchor | null; resolved_at: Date | string | null;
};

const LINK_COLUMNS = "link_id,conversation_id,page_id,block_id,source,created_at,last_seen_at,anchor_json,resolved_at";

function linkOf(row: LinkRow): PageLink {
  return { linkId: row.link_id, conversationId: row.conversation_id, pageId: row.page_id,
    blockId: row.block_id, source: row.source, createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at),
    anchor: row.anchor_json ?? null, resolvedAt: row.resolved_at === null ? null : iso(row.resolved_at) };
}

/** A page's or a conversation's links, the most recently seen first. */
function linkRows(tx: DatabaseTransaction, spaceId: string, pageId: string | null, conversationId: string | null) {
  return tx.query<LinkRow>({
    name: "page_links_list_v2",
    text: `SELECT ${LINK_COLUMNS}
      FROM data.page_links WHERE space_id=$1
        AND ($2::text IS NULL OR page_id=$2) AND ($3::text IS NULL OR conversation_id=$3)
      ORDER BY last_seen_at DESC, link_id LIMIT ${MAX_LINKS}`,
    values: [spaceId, pageId, conversationId], maxRows: MAX_LINKS,
  });
}

/** A discussion's anchor as a client sent it: a bounded quote and two opaque positions. */
function linkAnchor(value: PageLinkAnchor): PageLinkAnchor {
  const quote = typeof value?.quote === "string" ? value.quote.trim().slice(0, 1000) : "";
  const position = (entry: unknown) => (entry !== null && typeof entry === "object" && !Array.isArray(entry));
  if (!quote || !position(value.from) || !position(value.to)) {
    throw new PageControlError("invalid_request", 400, "an anchor is a quote with from and to positions");
  }
  const anchor = { quote, from: value.from, to: value.to };
  if (JSON.stringify(anchor).length > 4000) throw new PageControlError("invalid_request", 400, "the anchor is too large");
  return anchor;
}

function revisionOf(row: RevisionRow): PageRevision {
  return {
    revision: Number(row.revision), kind: row.kind,
    authors: Array.isArray(row.authors_json) ? row.authors_json : [],
    conversationIds: row.conversation_ids ?? [],
    basedOnRevision: row.based_on_revision === null ? null : Number(row.based_on_revision),
    createdAt: iso(row.created_at),
  };
}

export interface PageActor {
  /** The human whose page access governs, and who authors structure. */
  userId: string;
  role: "owner" | "admin" | "member" | "viewer" | "participant";
  author: PageAuthor;
  isAgent: boolean;
}

type Actor = PageActor;

/**
 * A committed revision. When it moved the head, `automationChannels` are the
 * conversations whose Automations it paused or resumed; their coordinators
 * must hear of it (docs/design/pages-live-document.md §6.4). The detached and
 * attached Automations are told to whoever wrote the edit.
 */
export interface PageCommit {
  page: PageSummary; revision: PageRevision; automationChannels: string[];
  detachedAutomations: PageAutomationAnchorChange[]; attachedAutomations: PageAutomationAnchorChange[];
}

interface AccessView { canRead: boolean; canEdit: boolean }

/** Who is acting: a Space member, or a live Agent Run acting with its owner's access. */
export async function pageActor(tx: DatabaseTransaction, spaceId: string, principal: PagePrincipal,
write: boolean): Promise<PageActor> {
  let userId = principal.id;
  if (principal.kind === "agent") {
    const run = (await tx.query<QueryResultRow & { owner_user_id: string; channel_id: string;
      metadata_json: Record<string, unknown> | null }>({
      name: "page_agent_run_v2",
      text: "SELECT owner_user_id, channel_id, metadata_json FROM data.runs WHERE run_id=$1 LIMIT 1",
      values: [bounded(principal.runProof?.runId, "runId")], maxRows: 1,
    }))[0];
    if (!run) throw new PageControlError("agent_run_forbidden", 403);
    // Proves the exact Run is live in this Space, as its Channel access does.
    await requireAgentChannelAccess(tx, { spaceId, channelId: run.channel_id, agentId: principal.id,
      runProof: principal.runProof, capability: write ? "message_active_command" : "content_history_read" });
    userId = run.owner_user_id;
  }
  const member = (await tx.query<QueryResultRow & { role: Actor["role"] }>({
    name: "page_actor_member_v1",
    text: "SELECT role FROM data.space_members WHERE space_id=$1 AND user_id=$2 LIMIT 1",
    values: [spaceId, userId], maxRows: 1,
  }))[0];
  if (!member) throw new PageControlError("space_not_found", 404);
  const label = (principal.label ?? principal.id).slice(0, 200);
  return {
    userId, role: member.role, isAgent: principal.kind === "agent",
    author: principal.kind === "agent"
      ? { kind: "agent", id: principal.id, label, ownerUserId: userId }
      : { kind: "user", id: principal.id, label },
  };
}

/** Runs a transaction on the Space's shard, which must not be moving. */
export async function inActiveSpace<T>(database: AuthorityDatabase,
  input: { requestId: string; operation: string; spaceId: string },
  ErrorType: new (code: string, status: number) => Error,
  callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
  const { requestId, operation, spaceId } = input;
  const placement = await new PostgresSpacePlacementDirectory(database).find({ requestId, operation }, spaceId);
  if (!placement) throw new ErrorType("space_not_found", 404);
  if (placement.state !== "active" || placement.targetShardId !== null) {
    // A Space that is moving shards is back in moments: say so, whichever
    // domain asked, so every client retries it like the other controls do.
    throw new ControlError("space_placement_unavailable", 503, "Space placement is unavailable", true);
  }
  return database.transaction({ requestId, operation,
    placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch } }, callback);
}

/** A page as one actor sees it: their access, and whether it is the Space's governance page. */
type TreeRow = PageRow & AccessView & { governance: boolean };

/** Every page in the Space with the actor's effective access, parents first. */
async function accessibleTree(tx: DatabaseTransaction, spaceId: string, actor: Actor): Promise<TreeRow[]> {
  const rows = await tx.query<PageRow>({
    name: "page_tree_v2",
    text: `SELECT page_id,parent_page_id,title,position,access_mode,head_revision,
        agent_suggest_only,updated_at,version,published_at
      FROM data.pages WHERE space_id=$1 ORDER BY parent_page_id NULLS FIRST, position, page_id
      LIMIT ${MAX_PAGES + 1}`,
    values: [spaceId], maxRows: MAX_PAGES + 1,
  });
  if (rows.length > MAX_PAGES) throw new PageControlError("page_tree_too_large", 409);
  const grants = await tx.query<QueryResultRow & { page_id: string; access: "read" | "edit" }>({
    name: "page_access_for_user_v1",
    text: `SELECT page_id, access FROM data.page_access
      WHERE space_id=$1 AND subject_kind='user' AND subject_id=$2 LIMIT ${MAX_PAGES}`,
    values: [spaceId, actor.userId], maxRows: MAX_PAGES,
  });
  const grant = new Map(grants.map((row) => [row.page_id, row.access]));
  const byId = new Map(rows.map((row) => [row.page_id, row]));
  const admin = actor.role === "owner" || actor.role === "admin";
  const memo = new Map<string, AccessView>();
  const resolve = (pageId: string, depth = 0): AccessView => {
    const cached = memo.get(pageId);
    if (cached) return cached;
    const row = byId.get(pageId);
    let view: AccessView;
    if (!row || depth > MAX_DEPTH) view = { canRead: false, canEdit: false };
    else if (row.access_mode === "restricted") {
      const own = grant.get(pageId);
      view = { canRead: admin || own !== undefined, canEdit: admin || own === "edit" };
    } else if (row.parent_page_id) view = resolve(row.parent_page_id, depth + 1);
    else view = { canRead: true, canEdit: !readsOnly(actor.role) };
    memo.set(pageId, view);
    return view;
  };
  // The Space's governance page is its maintainers' to edit (open-project-governance.md §4).
  const governancePageId = (await tx.query<QueryResultRow & { page_id: string | null }>({
    name: "page_governance_page_v1",
    text: "SELECT metadata_json->>'governancePageId' AS page_id FROM data.spaces WHERE space_id=$1",
    values: [spaceId], maxRows: 1,
  }))[0]?.page_id ?? null;
  return rows.map((row) => {
    const view = resolve(row.page_id);
    const governance = row.page_id === governancePageId;
    return { ...row, ...view, governance, canEdit: view.canEdit && (admin || !governance) };
  }).filter((row) => row.canRead);
}

/** Every page a principal can read in a Space, with whether they can edit it; none when they are not a member. */
export async function pageAccessMap(tx: DatabaseTransaction, spaceId: string, principal: PagePrincipal):
  Promise<Map<string, { canEdit: boolean; agentSuggestOnly: boolean }>> {
  let actor: PageActor;
  try {
    actor = await pageActor(tx, spaceId, principal, false);
  } catch (error) {
    if (error instanceof PageControlError && error.status < 500) return new Map();
    throw error;
  }
  return new Map((await accessibleTree(tx, spaceId, actor)).map((row) =>
    [row.page_id, { canEdit: row.canEdit, agentSuggestOnly: row.agent_suggest_only }]));
}

/**
 * What a principal may do with one page, in the caller's transaction. An
 * Agent Run acts with its owner's access, and only while it is live.
 */
export async function pageAccess(tx: DatabaseTransaction, spaceId: string, principal: PagePrincipal,
  pageId: string, write: boolean): Promise<{ canRead: boolean; canEdit: boolean; agentSuggestOnly: boolean;
    actor: PageActor }> {
  const actor = await pageActor(tx, spaceId, principal, write);
  const row = (await accessibleTree(tx, spaceId, actor)).find((item) => item.page_id === pageId);
  return { canRead: Boolean(row), canEdit: Boolean(row?.canEdit), agentSuggestOnly: Boolean(row?.agent_suggest_only),
    actor };
}

export class PostgresPageRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new PageControlError("cached_authority_forbidden", 500);
  }

  private inSpace<T>(requestId: string, operation: string, spaceId: string,
    callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return inActiveSpace(this.database, { requestId, operation, spaceId }, PageControlError, callback);
  }

  private accessibleTree(tx: DatabaseTransaction, spaceId: string, actor: Actor): Promise<TreeRow[]> {
    return accessibleTree(tx, spaceId, actor);
  }

  private async page(tx: DatabaseTransaction, spaceId: string, actor: Actor, pageId: string,
    need: "read" | "edit"): Promise<TreeRow> {
    const tree = await this.accessibleTree(tx, spaceId, actor);
    const row = tree.find((item) => item.page_id === pageId);
    if (!row) throw new PageControlError("page_not_found", 404);
    if (need === "edit" && !row.canEdit) throw new PageControlError("page_edit_forbidden", 403);
    return row;
  }

  private requireStructure(actor: Actor): void {
    if (readsOnly(actor.role)) throw new PageControlError("page_edit_forbidden", 403);
  }

  private summary(row: TreeRow): PageSummary {
    return {
      pageId: row.page_id, parentPageId: row.parent_page_id, title: row.title, position: row.position,
      accessMode: row.access_mode, headRevision: Number(row.head_revision),
      agentSuggestOnly: row.agent_suggest_only,
      canEdit: row.canEdit,
      updatedAt: iso(row.updated_at),
      publishedAt: row.published_at === null ? null : iso(row.published_at),
      governance: row.governance,
    };
  }

  /** The Space a conversation belongs to, for a principal that may read it. */
  async spaceOfConversation(input: { requestId: string; conversationId: string; principal: PagePrincipal }):
    Promise<{ spaceId: string }> {
    return this.inConversation(input, "page.conversation.space", async (_tx, spaceId) => ({ spaceId }));
  }

  /**
   * The pages a conversation is linked to, whole at their heads, for the
   * mirror a Run reads: the most recently linked first, at most 20. Daemons
   * refresh every hosted conversation's mirror every 15 seconds, so this is
   * one transaction rather than a space lookup, a link list and a read per page.
   */
  async conversationPages(input: { requestId: string; conversationId: string; principal: PagePrincipal }):
    Promise<{ spaceId: string; pages: PageDocument[] }> {
    return this.inConversation(input, "page.conversation.pages", async (tx, spaceId, actor) => {
      const tree = new Map((await this.accessibleTree(tx, spaceId, actor)).map((row) => [row.page_id, row]));
      const links = await linkRows(tx, spaceId, null, input.conversationId);
      const pageIds = [...new Set(links.map((link) => link.page_id).filter((pageId) => tree.has(pageId)))]
        .slice(0, MAX_CONVERSATION_PAGES);
      if (pageIds.length === 0) return { spaceId, pages: [] };
      const revisions = new Map((await tx.query<RevisionRow & { page_id: string }>({
        name: "page_head_revisions_v1",
        text: `SELECT r.page_id,r.revision,r.kind,r.body,r.authors_json,r.conversation_ids,r.based_on_revision,r.created_at
          FROM data.page_revisions r JOIN unnest($2::text[], $3::bigint[]) AS head(page_id, revision)
            ON r.page_id=head.page_id AND r.revision=head.revision
          WHERE r.space_id=$1`,
        values: [spaceId, pageIds, pageIds.map((pageId) => String(tree.get(pageId)!.head_revision))],
        maxRows: pageIds.length,
      })).map((row) => [row.page_id, row]));
      return { spaceId, pages: pageIds.map((pageId) => {
        const rev = revisions.get(pageId);
        if (!rev) throw new PageControlError("page_revision_not_found", 404);
        return { ...this.summary(tree.get(pageId)!), body: rev.body ?? "", revisionInfo: revisionOf(rev) };
      }) };
    });
  }

  /** Runs `callback` in the conversation's Space, as a reader who may read the conversation. */
  private async inConversation<T>(input: { requestId: string; conversationId: string; principal: PagePrincipal },
    operation: string, callback: (tx: DatabaseTransaction, spaceId: string, actor: Actor) => Promise<T>): Promise<T> {
    const conversationId = bounded(input.conversationId, "conversationId");
    const requestId = bounded(input.requestId, "requestId");
    const route = await new PostgresChannelSpaceDirectory(this.database).resolve(
      { requestId, operation: "page.conversation.resolve" }, conversationId);
    if (!route) throw new PageControlError("channel_not_found", 404);
    return this.inSpace(requestId, operation, route.spaceId, async (tx) => {
      const actor = await pageActor(tx, route.spaceId, input.principal, false);
      await requireChannelCapability(tx, { capability: "message_content_read", channelId: conversationId,
        spaceId: route.spaceId, principal: { kind: "user", id: actor.userId },
        error: (failure) => new PageControlError(failure.code, failure.status) });
      return callback(tx, route.spaceId, actor);
    });
  }

  async tree(input: { requestId: string; spaceId: string; principal: PagePrincipal }):
    Promise<{ pages: PageSummary[] }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.tree", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const tree = await this.accessibleTree(tx, spaceId, actor);
      return { pages: tree.map((row) => this.summary(row)) };
    });
  }

  /**
   * Title and current text of every page the principal can read. A restricted
   * page the reader cannot open is not a candidate, same as the tree.
   */
  async search(input: { requestId: string; spaceId: string; principal: PagePrincipal; query: string }):
    Promise<{ results: PageSearchHit[] }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query || query.length > 200) throw new PageControlError("invalid_request", 400, "Search query is invalid");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.search", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const tree = await this.accessibleTree(tx, spaceId, actor);
      if (tree.length === 0) return { results: [] };
      const rows = await tx.query<QueryResultRow & { page_id: string; title: string; body: string }>({
        name: "page_search_heads_v1",
        text: `SELECT p.page_id, p.title, r.body
          FROM data.pages p
          JOIN data.page_revisions r
            ON r.space_id=p.space_id AND r.page_id=p.page_id AND r.revision=p.head_revision
          WHERE p.space_id=$1 AND p.page_id = ANY($2::text[])
            AND (strpos(lower(p.title), lower($3)) > 0 OR strpos(lower(r.body), lower($3)) > 0)
          ORDER BY p.updated_at DESC
          LIMIT ${PAGE_SEARCH_RESULT_LIMIT}`,
        values: [spaceId, tree.map((row) => row.page_id), query],
        maxRows: PAGE_SEARCH_RESULT_LIMIT,
      });
      return { results: rows.map((row) => pageSearchHit(row.title, row.body ?? "", row.page_id, query)) };
    });
  }

  async read(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    revision?: number; conversationId?: string; blockId?: string }): Promise<{ page: PageDocument }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.read", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const row = await this.page(tx, spaceId, actor, pageId, "read");
      const revision = input.revision === undefined ? Number(row.head_revision) : input.revision;
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new PageControlError("invalid_request", 400, "revision is invalid");
      }
      const rev = (await tx.query<RevisionRow>({
        name: "page_revision_read_v1",
        text: `SELECT revision,kind,body,authors_json,conversation_ids,based_on_revision,created_at
          FROM data.page_revisions WHERE space_id=$1 AND page_id=$2 AND revision=$3`,
        values: [spaceId, pageId, revision], maxRows: 1,
      }))[0];
      if (!rev) throw new PageControlError("page_revision_not_found", 404);
      if (input.conversationId) {
        await this.recordLink(tx, spaceId, actor, input.principal, {
          conversationId: input.conversationId, pageId, blockId: blockId(input.blockId), source: "read",
        });
      }
      return { page: { ...this.summary(row), body: rev.body ?? "", revisionInfo: revisionOf(rev) } };
    });
  }

  async create(input: { requestId: string; spaceId: string; principal: PagePrincipal;
    parentPageId?: string | null; title: string; body?: string; afterPageId?: string | null;
    accessMode?: "open" | "restricted" }): Promise<{ page: PageSummary }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const newTitle = pageTitle(input.title);
    const newBody = pageBody(input.body ?? `# ${newTitle}\n`);
    const accessMode = input.accessMode ?? "open";
    if (accessMode !== "open" && accessMode !== "restricted") {
      throw new PageControlError("invalid_request", 400, "accessMode is open or restricted");
    }
    return this.inSpace(bounded(input.requestId, "requestId"), "page.create", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      this.requireStructure(actor);
      const parentPageId = input.parentPageId ? bounded(input.parentPageId, "parentPageId") : null;
      if (parentPageId) await this.page(tx, spaceId, actor, parentPageId, "edit");
      else if (actor.role !== "owner" && actor.role !== "admin" && (await this.rootCount(tx, spaceId)) > 0) {
        throw new PageControlError("page_root_admin_only", 403, "Only Space owners and admins add top-level pages");
      }
      const position = await this.positionAfter(tx, spaceId, parentPageId, input.afterPageId ?? null);
      const pageId = crypto.randomUUID();
      const now = new Date().toISOString();
      await tx.query({
        name: "page_create_v1",
        text: `INSERT INTO data.pages (space_id,page_id,parent_page_id,title,position,access_mode,
            head_revision,agent_suggest_only,version,created_by_user_id,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,1,FALSE,1,$7,$8,$8)`,
        values: [spaceId, pageId, parentPageId, newTitle, position, accessMode, actor.userId, now],
        maxRows: 0,
      });
      if (accessMode === "restricted") {
        await tx.query({
          name: "page_access_creator_v1",
          text: `INSERT INTO data.page_access (space_id,page_id,subject_kind,subject_id,access,created_at)
            VALUES ($1,$2,'user',$3,'edit',$4)`,
          values: [spaceId, pageId, actor.userId, now], maxRows: 0,
        });
      }
      await this.insertRevision(tx, spaceId, pageId, 1, newBody, [actor.author], [], "edit", null, now);
      const row = await this.page(tx, spaceId, actor, pageId, "read");
      return { page: this.summary(row) };
    });
  }

  private async rootCount(tx: DatabaseTransaction, spaceId: string): Promise<number> {
    const rows = await tx.query<QueryResultRow & { count: string }>({
      name: "page_root_count_v1",
      text: "SELECT count(*)::text AS count FROM data.pages WHERE space_id=$1 AND parent_page_id IS NULL",
      values: [spaceId], maxRows: 1,
    });
    return Number(rows[0]?.count ?? 0);
  }

  private async positionAfter(tx: DatabaseTransaction, spaceId: string, parentPageId: string | null,
    afterPageId: string | null): Promise<string> {
    const siblings = await tx.query<QueryResultRow & { page_id: string; position: string }>({
      name: "page_siblings_v1",
      text: `SELECT page_id, position FROM data.pages WHERE space_id=$1
        AND parent_page_id IS NOT DISTINCT FROM $2 ORDER BY position, page_id LIMIT ${MAX_PAGES}`,
      values: [spaceId, parentPageId], maxRows: MAX_PAGES,
    });
    if (afterPageId === null) {
      const last = siblings.at(-1);
      return pagePositionBetween(last?.position ?? null, null);
    }
    const index = siblings.findIndex((row) => row.page_id === afterPageId);
    if (index < 0) throw new PageControlError("page_not_found", 404, "afterPageId is not a sibling");
    return pagePositionBetween(siblings[index]!.position, siblings[index + 1]?.position ?? null);
  }

  private async insertRevision(tx: DatabaseTransaction, spaceId: string, pageId: string, revision: number,
    text: string, authors: PageAuthor[], conversationIds: string[], kind: PageRevision["kind"],
    basedOn: number | null, now: string): Promise<void> {
    await tx.query({
      name: "page_revision_insert_v1",
      text: `INSERT INTO data.page_revisions (space_id,page_id,revision,body,authors_json,
          conversation_ids,kind,based_on_revision,created_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::text[],$7,$8,$9)`,
      values: [spaceId, pageId, revision, text, JSON.stringify(authors), conversationIds, kind, basedOn, now],
      maxRows: 0,
    });
  }

  /**
   * Commits a new head. `baseRevision` is the head the editor loaded; if the
   * head has moved the edit is refused with the current head so the caller can
   * rebase. Agents on a suggest-only page produce a suggestion instead.
   */
  async edit(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    baseRevision: number; body: string; conversationIds?: string[]; coAuthors?: PageAuthor[];
    blockIds?: string[] }): Promise<PageCommit> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.edit", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      return this.commitEdit(tx, spaceId, actor, input.principal, pageId, {
        baseRevision: input.baseRevision, body: input.body, conversationIds: input.conversationIds ?? [],
        coAuthors: input.coAuthors ?? [], blockIds: input.blockIds ?? [], kind: "edit",
      });
    });
  }

  /**
   * Commits a new head. `baseRevision` is the head the editor loaded; if the
   * head has moved the edit is refused with the current head so the caller can
   * rebase. Agents on a suggest-only page produce a suggestion instead.
   */
  private async commitEdit(tx: DatabaseTransaction, spaceId: string, actor: Actor, principal: PagePrincipal,
    pageId: string, input: { baseRevision: number; body: string; conversationIds: string[];
      coAuthors: PageAuthor[]; blockIds: string[]; kind: "edit" | "accepted" | "restore" }):
    Promise<PageCommit> {
    const text = pageBody(input.body);
    const conversationIds = [...new Set(input.conversationIds.map((id) => bounded(id, "conversationId")))];
    if (conversationIds.length > 64) throw new PageControlError("invalid_request", 400, "too many conversations");
    const blocks = [...new Set(input.blockIds.map(blockId))].slice(0, 50);
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1) {
      throw new PageControlError("invalid_request", 400, "baseRevision is invalid");
    }
    const row = await this.page(tx, spaceId, actor, pageId, "edit");
    const locked = (await tx.query<QueryResultRow & { head_revision: string | number }>({
      name: "page_head_lock_v1",
      text: "SELECT head_revision FROM data.pages WHERE space_id=$1 AND page_id=$2 FOR UPDATE",
      values: [spaceId, pageId], maxRows: 1,
    }))[0];
    const head = Number(locked?.head_revision ?? row.head_revision);
    const next = (await tx.query<QueryResultRow & { next: string }>({
      name: "page_revision_next_v1",
      text: "SELECT (COALESCE(MAX(revision),0)+1)::text AS next FROM data.page_revisions WHERE space_id=$1 AND page_id=$2",
      values: [spaceId, pageId], maxRows: 1,
    }))[0]!;
    const revision = Number(next.next);
    const now = new Date().toISOString();
    const authors = dedupeAuthors([actor.author, ...input.coAuthors.map(validAuthor)]);
    const suggestion = input.kind === "edit" && actor.isAgent && row.agent_suggest_only;
    if (!suggestion && input.baseRevision !== head) {
      const current = (await tx.query<RevisionRow>({
        name: "page_revision_head_v1",
        text: `SELECT revision,kind,body,authors_json,conversation_ids,based_on_revision,created_at
          FROM data.page_revisions WHERE space_id=$1 AND page_id=$2 AND revision=$3`,
        values: [spaceId, pageId, head], maxRows: 1,
      }))[0];
      throw new PageControlError("page_revision_conflict", 409,
        "The page changed since you read it; merge your edit into the current revision and retry",
        { headRevision: head, body: current?.body ?? "" });
    }
    await this.insertRevision(tx, spaceId, pageId, revision, text, authors, conversationIds,
      suggestion ? "suggestion" : input.kind, input.baseRevision, now);
    const anchoring = suggestion ? { channels: [], detached: [], attached: [] } : await (async () => {
      await tx.query({
        name: "page_head_advance_v1",
        text: `UPDATE data.pages SET head_revision=$3, version=version+1, updated_at=$4
          WHERE space_id=$1 AND page_id=$2`,
        values: [spaceId, pageId, revision, now], maxRows: 0,
      });
      return reconcilePageAutomations(tx, { spaceId, pageId, body: text, at: now, revision });
    })();
    for (const conversationId of conversationIds) {
      for (const block of blocks.length ? blocks : [""]) {
        await this.recordLink(tx, spaceId, actor, principal,
          { conversationId, pageId, blockId: block, source: "edit" });
      }
    }
    const updated = await this.page(tx, spaceId, actor, pageId, "read");
    return { page: this.summary(updated), revision: {
      revision, kind: suggestion ? "suggestion" : input.kind, authors, conversationIds,
      basedOnRevision: input.baseRevision, createdAt: now,
    }, automationChannels: anchoring.channels, detachedAutomations: anchoring.detached,
    attachedAutomations: anchoring.attached };
  }

  /** Accepts a suggestion, or restores an earlier revision, as a new head. */
  async promote(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    revision: number; baseRevision: number }): Promise<PageCommit> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.promote", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      const row = await this.page(tx, spaceId, actor, pageId, "edit");
      // On a page set to take Agent edits as suggestions, accepting one stays with a person.
      if (actor.isAgent && row.agent_suggest_only) throw new PageControlError("page_suggest_only", 403);
      const source = (await tx.query<RevisionRow>({
        name: "page_revision_source_v1",
        text: `SELECT revision,kind,body,authors_json,conversation_ids,based_on_revision,created_at
          FROM data.page_revisions WHERE space_id=$1 AND page_id=$2 AND revision=$3`,
        values: [spaceId, pageId, input.revision], maxRows: 1,
      }))[0];
      if (!source || source.kind === "purge") throw new PageControlError("page_revision_not_found", 404);
      const kind = source.kind === "suggestion" ? "accepted" as const : "restore" as const;
      return this.commitEdit(tx, spaceId, actor, input.principal, pageId, {
        baseRevision: input.baseRevision, body: source.body ?? "",
        conversationIds: source.conversation_ids ?? [],
        coAuthors: kind === "accepted" && Array.isArray(source.authors_json) ? source.authors_json : [],
        blockIds: [], kind,
      });
    });
  }

  async history(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    before?: number; limit?: number }): Promise<{ revisions: PageRevision[] }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), MAX_HISTORY);
    return this.inSpace(bounded(input.requestId, "requestId"), "page.history", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      await this.page(tx, spaceId, actor, pageId, "read");
      const rows = await tx.query<RevisionRow>({
        name: "page_history_v1",
        text: `SELECT revision,kind,authors_json,conversation_ids,based_on_revision,created_at
          FROM data.page_revisions WHERE space_id=$1 AND page_id=$2
            AND ($3::bigint IS NULL OR revision < $3)
          ORDER BY revision DESC LIMIT ${limit}`,
        values: [spaceId, pageId, input.before ?? null], maxRows: limit,
      });
      return { revisions: rows.map(revisionOf) };
    });
  }

  /**
   * When each section of the head last changed, and by whom in which
   * conversation: derived from the recent revisions, newest first.
   */
  async blockUpdates(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal }):
    Promise<{ headRevision: number; order: string[]; updates: Map<string, PageBlockAwareness["updated"]>;
      owed: Map<string, PageOwedUpdate> }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.block-updates", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const row = await this.page(tx, spaceId, actor, pageId, "read");
      const headRevision = Number(row.head_revision);
      const rows = await tx.query<RevisionRow>({
        name: "page_block_updates_v1",
        text: `SELECT revision,kind,body,authors_json,conversation_ids,based_on_revision,created_at
          FROM data.page_revisions WHERE space_id=$1 AND page_id=$2 AND revision <= $3
            AND kind NOT IN ('suggestion','purge')
          ORDER BY revision DESC LIMIT ${BLOCK_UPDATE_REVISIONS}`,
        values: [spaceId, pageId, headRevision], maxRows: BLOCK_UPDATE_REVISIONS,
      });
      const updates = new Map<string, PageBlockAwareness["updated"]>();
      // Compared as documents, so a change of markdown style is no change. Only
      // sections whose text differs are put in canonical form: the whole of a
      // long page's recent revisions is seconds of CPU, which stalls every
      // request sharing the isolate (XMATRIX-HUB-68, XMATRIX-HUB-69).
      const bodies = rows.map((revision) => revision.body ?? "");
      const canonicalSections = new Map<string, string>();
      const canonical = (section: string) => {
        let form = canonicalSections.get(section);
        if (form === undefined) canonicalSections.set(section, form = canonicalPageMarkdown(section));
        return form;
      };
      const order = pageBlocks(bodies[0] ?? "").map((block) => block.id);
      const open = new Set(order);
      for (let index = 0; index < rows.length && open.size; index++) {
        const newer = rows[index]!;
        const older = rows[index + 1];
        // The first revision in reach wrote whatever is left, if it is the page's first.
        const changed = older ? pageChangedDocBlocks(bodies[index + 1]!, bodies[index]!, canonical, open)
          : Number(newer.revision) === 1 ? [...open] : [];
        for (const blockId of changed) {
          if (!open.delete(blockId)) continue;
          const { revision, authors, conversationIds, createdAt } = revisionOf(newer);
          updates.set(blockId, { revision, authors, conversationIds, createdAt });
        }
      }
      // Claimed work that ended after its section last changed, not yet written back (§5).
      const ended = await tx.query<QueryResultRow & { block_id: string; state: string; holder_label: string;
        conversation_id: string | null; pull_request_url: string | null; claimed_at: Date | string;
        ended_at: Date | string }>({
        name: "page_claims_owed_v2",
        text: `SELECT block_id,state,holder_label,conversation_id,pull_request_url,created_at AS claimed_at,
            CASE WHEN state='active' THEN expires_at ELSE updated_at END AS ended_at
          FROM data.page_claims WHERE space_id=$1 AND page_id=$2 AND written_back_at IS NULL
            AND (state IN ('completed','released') OR (state='active' AND expires_at <= now()))
            AND updated_at > now() - interval '${OWED_WINDOW_DAYS} days'
          ORDER BY ended_at DESC LIMIT ${MAX_LINKS}`,
        values: [spaceId, pageId], maxRows: MAX_LINKS,
      });
      const owed = new Map<string, PageOwedUpdate>();
      for (const row of ended) {
        const at = iso(row.ended_at);
        const update = updates.get(row.block_id);
        // A release ends a lease, not work: a section its holder's conversation
        // wrote while holding it was written back before the release.
        const wroteBack = row.state === "released" && row.conversation_id !== null
          && update?.conversationIds.includes(row.conversation_id) === true && update.createdAt >= iso(row.claimed_at);
        if (owed.has(row.block_id) || (update && update.createdAt >= at) || wroteBack) continue;
        owed.set(row.block_id, { reason: row.state === "completed" ? "merged" : row.state === "released" ? "released"
          : "lapsed", at, holder: row.holder_label, conversationId: row.conversation_id,
          pullRequestUrl: row.pull_request_url });
      }
      return { headRevision, order, updates, owed };
    });
  }

  /**
   * The pages the reader can read that changed last, newest first, each with
   * its latest change: the section and the first text it added, read from
   * the page's last two revisions.
   */
  async recentChanges(input: { requestId: string; spaceId: string; principal: PagePrincipal; limit?: number }):
    Promise<{ changes: PageRecentChange[] }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const requested = Number.isFinite(input.limit) ? Math.trunc(input.limit!) : RECENT_CHANGES;
    const limit = Math.min(Math.max(requested, 1), MAX_RECENT_CHANGES);
    return this.inSpace(bounded(input.requestId, "requestId"), "page.recent-changes", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      // A page's updated_at moves with its head, so the newest are the candidates;
      // a rename or move also moves it, which is why a few spare are read.
      const candidates = (await this.accessibleTree(tx, spaceId, actor))
        .sort((a, b) => Date.parse(iso(b.updated_at)) - Date.parse(iso(a.updated_at)))
        .slice(0, limit + RECENT_CHANGE_SPARES);
      if (candidates.length === 0) return { changes: [] };
      const rows = await tx.query<RevisionRow & { page_id: string }>({
        name: "page_recent_revisions_v1",
        text: `SELECT head.page_id,r.revision,r.kind,r.body,r.authors_json,r.conversation_ids,r.based_on_revision,r.created_at
          FROM unnest($2::text[], $3::bigint[]) AS head(page_id, revision)
          CROSS JOIN LATERAL (
            SELECT revision,kind,body,authors_json,conversation_ids,based_on_revision,created_at
              FROM data.page_revisions
              WHERE space_id=$1 AND page_id=head.page_id AND revision <= head.revision
                AND kind NOT IN ('suggestion','purge')
              ORDER BY revision DESC LIMIT 2) r`,
        values: [spaceId, candidates.map((row) => row.page_id), candidates.map((row) => String(row.head_revision))],
        maxRows: candidates.length * 2,
      });
      const byPage = new Map<string, Array<RevisionRow & { page_id: string }>>();
      for (const row of rows) byPage.set(row.page_id, [...(byPage.get(row.page_id) ?? []), row]);
      const changes: PageRecentChange[] = [];
      for (const page of candidates) {
        const [head, before] = (byPage.get(page.page_id) ?? []).sort((a, b) => Number(b.revision) - Number(a.revision));
        if (!head) continue;
        const after = canonicalPageMarkdown(head.body ?? "");
        const { revision, authors, createdAt } = revisionOf(head);
        const created = !before && revision === 1;
        const { blockId, gist } = before ? pageChangeGist(canonicalPageMarkdown(before.body ?? ""), after)
          : { blockId: null, gist: null };
        const block = blockId ? pageBlocks(after).find((item) => item.id === blockId) : undefined;
        changes.push({ pageId: page.page_id, title: page.title, revision, createdAt, authors, created,
          block: block ? { id: block.id, title: block.title } : null, gist });
      }
      changes.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return { changes: changes.slice(0, limit) };
    });
  }

  async update(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    title?: string; parentPageId?: string | null; afterPageId?: string | null;
    accessMode?: "open" | "restricted"; agentSuggestOnly?: boolean;
    access?: Array<{ userId: string; access: "read" | "edit" }> }): Promise<{ page: PageSummary }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.update", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      this.requireStructure(actor);
      const row = await this.page(tx, spaceId, actor, pageId, "edit");
      const now = new Date().toISOString();
      let parent = row.parent_page_id;
      let position = row.position;
      if (input.parentPageId !== undefined || input.afterPageId !== undefined) {
        parent = input.parentPageId === undefined ? row.parent_page_id
          : input.parentPageId === null ? null : bounded(input.parentPageId, "parentPageId");
        if (parent) {
          await this.page(tx, spaceId, actor, parent, "edit");
          await this.rejectCycle(tx, spaceId, pageId, parent);
        } else if (actor.role !== "owner" && actor.role !== "admin") {
          throw new PageControlError("page_root_admin_only", 403);
        }
        position = await this.positionAfter(tx, spaceId, parent, input.afterPageId ?? null);
      }
      const admin = actor.role === "owner" || actor.role === "admin";
      if ((input.accessMode !== undefined || input.access !== undefined) && !admin) {
        throw new PageControlError("page_access_admin_only", 403, "Only Space owners and admins change page access");
      }
      const accessMode = input.accessMode ?? row.access_mode;
      if (accessMode !== "open" && accessMode !== "restricted") {
        throw new PageControlError("invalid_request", 400, "accessMode is open or restricted");
      }
      await tx.query({
        name: "page_update_v1",
        text: `UPDATE data.pages SET title=$3, parent_page_id=$4, position=$5, access_mode=$6,
            agent_suggest_only=$7, version=version+1, updated_at=$8
          WHERE space_id=$1 AND page_id=$2`,
        values: [spaceId, pageId, input.title === undefined ? row.title : pageTitle(input.title), parent, position,
          accessMode, input.agentSuggestOnly ?? row.agent_suggest_only, now],
        maxRows: 0,
      });
      if (input.access !== undefined) {
        if (input.access.length > 500) throw new PageControlError("invalid_request", 400, "too many subjects");
        await tx.query({ name: "page_access_clear_v1",
          text: "DELETE FROM data.page_access WHERE space_id=$1 AND page_id=$2",
          values: [spaceId, pageId], maxRows: 0 });
        for (const subject of input.access) {
          if (subject.access !== "read" && subject.access !== "edit") {
            throw new PageControlError("invalid_request", 400, "access is read or edit");
          }
          await tx.query({ name: "page_access_set_v1",
            text: `INSERT INTO data.page_access (space_id,page_id,subject_kind,subject_id,access,created_at)
              SELECT $1,$2,'user',$3,$4,$5 WHERE EXISTS (
                SELECT 1 FROM data.space_members WHERE space_id=$1 AND user_id=$3)`,
            values: [spaceId, pageId, bounded(subject.userId, "userId"), subject.access, now], maxRows: 0 });
        }
      }
      const updated = await this.page(tx, spaceId, actor, pageId, "read");
      return { page: this.summary(updated) };
    });
  }

  private async rejectCycle(tx: DatabaseTransaction, spaceId: string, pageId: string, parent: string) {
    const rows = await tx.query<QueryResultRow & { page_id: string }>({
      name: "page_ancestors_v1",
      text: `WITH RECURSIVE up(page_id, parent_page_id, depth) AS (
          SELECT page_id, parent_page_id, 0 FROM data.pages WHERE space_id=$1 AND page_id=$2
          UNION ALL
          SELECT p.page_id, p.parent_page_id, up.depth+1 FROM data.pages p
            JOIN up ON p.page_id=up.parent_page_id WHERE p.space_id=$1 AND up.depth < ${MAX_DEPTH}
        ) SELECT page_id FROM up`,
      values: [spaceId, parent], maxRows: MAX_DEPTH + 1,
    });
    if (rows.some((row) => row.page_id === pageId)) {
      throw new PageControlError("page_move_cycle", 409, "A page cannot move under its own descendant");
    }
    if (rows.length > MAX_DEPTH) throw new PageControlError("page_tree_too_deep", 409);
  }

  /**
   * Whether the page row exists. For the page's own session, which must
   * confirm a removal's outcome before dropping what it stores; it returns
   * nothing about the page.
   */
  async exists(input: { requestId: string; spaceId: string; pageId: string }): Promise<boolean> {
    const spaceId = bounded(input.spaceId, "spaceId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.exists", spaceId, async (tx) =>
      (await tx.query({ name: "page_exists_v1", text: "SELECT 1 FROM data.pages WHERE space_id=$1 AND page_id=$2",
        values: [spaceId, bounded(input.pageId, "pageId")], maxRows: 1 })).length === 1);
  }

  /**
   * Publishes a page for anyone to read, or takes it down. It is a Space
   * owner's or admin's own act, and only a page every member may read can be
   * public: a restricted page, or one below a restricted page, stays private.
   */
  async publish(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    published: boolean }): Promise<{ page: PageSummary }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.publish", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      this.requireStructure(actor);
      if (actor.role !== "owner" && actor.role !== "admin") {
        throw new PageControlError("page_publish_admin_only", 403, "Only Space owners and admins publish pages");
      }
      const tree = await this.accessibleTree(tx, spaceId, actor);
      const row = tree.find((item) => item.page_id === pageId);
      if (!row) throw new PageControlError("page_not_found", 404);
      if (input.published && !openToEveryMember(tree, pageId)) {
        throw new PageControlError("page_not_publishable", 409,
          "Only a page every member may read can be public; it or a page above it is restricted");
      }
      await tx.query({
        name: "page_publish_v1",
        text: `UPDATE data.pages SET published_at=CASE WHEN $3 THEN COALESCE(published_at, now()) END,
            version=version+1, updated_at=now() WHERE space_id=$1 AND page_id=$2`,
        values: [spaceId, pageId, input.published], maxRows: 0,
      });
      return { page: this.summary(await this.page(tx, spaceId, actor, pageId, "read")) };
    });
  }

  /**
   * Claims a block for the caller, or renews the caller's own claim on it.
   * A block has one active claim at a time unless it is open for competition.
   */
  async claim(input: { requestId: string; spaceId: string; pageId: string; blockId?: string;
    principal: PagePrincipal; minutes?: number; conversationId?: string }): Promise<{ claim: PageClaim }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const block = blockId(input.blockId);
    const minutes = input.minutes ?? DEFAULT_CLAIM_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > MAX_CLAIM_MINUTES) {
      throw new PageControlError("invalid_request", 400, `A claim lasts 5-${MAX_CLAIM_MINUTES} minutes`);
    }
    return this.inSpace(bounded(input.requestId, "requestId"), "page.claim", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      await this.page(tx, spaceId, actor, pageId, "edit");
      await tx.query({ name: "page_claim_lock_v1", text: "SELECT 1 FROM data.pages WHERE space_id=$1 AND page_id=$2 FOR UPDATE",
        values: [spaceId, pageId], maxRows: 1 });
      const active = await this.activeClaims(tx, spaceId, pageId, block);
      const mine = active.find((claim) => claim.holder.kind === actor.author.kind && claim.holder.id === actor.author.id);
      const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
      if (mine) {
        await tx.query({ name: "page_claim_renew_v1",
          text: "UPDATE data.page_claims SET expires_at=$3, updated_at=now() WHERE space_id=$1 AND claim_id=$2",
          values: [spaceId, mine.claimId, expiresAt], maxRows: 0 });
        return { claim: { ...mine, expiresAt } };
      }
      if (active.length) {
        const competitive = await tx.query({ name: "page_block_competitive_v1",
          text: "SELECT 1 FROM data.page_block_competitions WHERE space_id=$1 AND page_id=$2 AND block_id=$3",
          values: [spaceId, pageId, block], maxRows: 1 });
        if (!competitive.length) {
          throw new PageControlError("page_block_claimed", 409, `${active[0]!.holder.label} is on this`,
            { claim: active[0] });
        }
      }
      const claim: PageClaim = {
        claimId: crypto.randomUUID(), pageId, blockId: block,
        holder: { kind: actor.author.kind, id: actor.author.id, label: actor.author.label },
        ownerUserId: actor.userId, conversationId: input.conversationId ?? null, pullRequestUrl: null, expiresAt,
        createdAt: new Date().toISOString(),
      };
      await tx.query({ name: "page_claim_create_v1",
        text: `INSERT INTO data.page_claims (space_id,claim_id,page_id,block_id,holder_kind,holder_id,holder_label,
            owner_user_id,conversation_id,state,expires_at,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$11)`,
        values: [spaceId, claim.claimId, pageId, block, claim.holder.kind, claim.holder.id, claim.holder.label,
          claim.ownerUserId, claim.conversationId, expiresAt, claim.createdAt], maxRows: 0 });
      return { claim };
    });
  }

  /** Releases a claim: its holder, the person it counts against, or a Space owner or admin. */
  async releaseClaim(input: { requestId: string; spaceId: string; pageId: string; claimId: string;
    principal: PagePrincipal }): Promise<{ released: boolean; blockId?: string }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.claim.release", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      await this.page(tx, spaceId, actor, pageId, "read");
      const released = await tx.query({ name: "page_claim_release_v2",
        text: `UPDATE data.page_claims SET state='released', updated_at=now()
          WHERE space_id=$1 AND page_id=$2 AND claim_id=$3 AND state='active'
            AND ((holder_kind=$4 AND holder_id=$5) OR owner_user_id=$6 OR $7)
          RETURNING claim_id, block_id`,
        values: [spaceId, pageId, bounded(input.claimId, "claimId"), actor.author.kind, actor.author.id, actor.userId,
          actor.role === "owner" || actor.role === "admin"], maxRows: 1 });
      return released[0] ? { released: true, blockId: String(released[0].block_id) } : { released: false };
    });
  }

  /**
   * The newest revision of a page this person has had on screen, or null before
   * they first read it. It is a person's own: an Agent Run has none.
   */
  async readState(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal }):
    Promise<{ revision: number | null }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    if (input.principal.kind !== "user") throw new PageControlError("page_read_state_human_only", 403);
    return this.inSpace(bounded(input.requestId, "requestId"), "page.read_state", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      await this.page(tx, spaceId, actor, pageId, "read");
      const row = (await tx.query<QueryResultRow & { revision: string }>({ name: "page_read_state_v1",
        text: "SELECT revision::text FROM data.page_reads WHERE space_id=$1 AND page_id=$2 AND user_id=$3",
        values: [spaceId, pageId, actor.userId], maxRows: 1 }))[0];
      return { revision: row ? Number(row.revision) : null };
    });
  }

  /** Moves how far this person has read a page forward to a revision the page has; it never moves back. */
  async markRead(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    revision: number }): Promise<{ revision: number }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    if (input.principal.kind !== "user") throw new PageControlError("page_read_state_human_only", 403);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new PageControlError("invalid_request", 400, "revision is invalid");
    }
    return this.inSpace(bounded(input.requestId, "requestId"), "page.mark_read", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const row = await this.page(tx, spaceId, actor, pageId, "read");
      const revision = Math.min(input.revision, Number(row.head_revision));
      const stored = (await tx.query<QueryResultRow & { revision: string }>({ name: "page_mark_read_v1",
        text: `INSERT INTO data.page_reads (space_id,page_id,user_id,revision,updated_at) VALUES ($1,$2,$3,$4,now())
          ON CONFLICT (space_id,page_id,user_id) DO UPDATE
            SET revision=GREATEST(data.page_reads.revision, EXCLUDED.revision),
              updated_at=CASE WHEN EXCLUDED.revision > data.page_reads.revision THEN EXCLUDED.updated_at
                ELSE data.page_reads.updated_at END
          RETURNING revision::text`,
        values: [spaceId, pageId, actor.userId, revision], maxRows: 1 }))[0]!;
      return { revision: Number(stored.revision) };
    });
  }

  /** The claims in force on a page, and the blocks open for competition. */
  async claims(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal }):
    Promise<{ claims: PageClaim[]; competitiveBlocks: string[] }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.claims", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      await this.page(tx, spaceId, actor, pageId, "read");
      const competitive = await tx.query<QueryResultRow & { block_id: string }>({ name: "page_block_competitions_v1",
        text: "SELECT block_id FROM data.page_block_competitions WHERE space_id=$1 AND page_id=$2 ORDER BY block_id LIMIT 500",
        values: [spaceId, pageId], maxRows: 500 });
      return { claims: await this.activeClaims(tx, spaceId, pageId), competitiveBlocks: competitive.map((row) => row.block_id) };
    });
  }

  /** Opens a block for competition, so several claims can run at once, or closes it again. */
  async setCompetition(input: { requestId: string; spaceId: string; pageId: string; blockId?: string;
    principal: PagePrincipal; open: boolean }): Promise<{ open: boolean }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const block = blockId(input.blockId);
    return this.inSpace(bounded(input.requestId, "requestId"), "page.claim.competition", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      this.requireStructure(actor);
      if (actor.role !== "owner" && actor.role !== "admin") {
        throw new PageControlError("page_competition_admin_only", 403, "Only Space owners and admins open a block for competition");
      }
      await this.page(tx, spaceId, actor, pageId, "read");
      await tx.query(input.open ? {
        name: "page_block_competition_open_v1",
        text: `INSERT INTO data.page_block_competitions (space_id,page_id,block_id,opened_by_user_id,opened_at)
          VALUES ($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING`,
        values: [spaceId, pageId, block, actor.userId], maxRows: 0,
      } : {
        name: "page_block_competition_close_v1",
        text: "DELETE FROM data.page_block_competitions WHERE space_id=$1 AND page_id=$2 AND block_id=$3",
        values: [spaceId, pageId, block], maxRows: 0,
      });
      return { open: input.open };
    });
  }

  /**
   * The GitHub claim check for one referenced block: the page, and the claim in
   * force on it that counts against this person, which the pull request then
   * does the work of. The caller has matched the pull request's author to the
   * person through their linked GitHub account (null when nobody linked it).
   * Also names the Space owner, whose GitHub connection publishes the check.
   */
  async pullRequestClaim(input: { requestId: string; spaceId: string; pageId: string; blockId?: string;
    ownerUserId: string | null; pullRequestUrl: string }):
    Promise<{ spaceOwnerUserId: string; pageTitle: string | null; restricted: boolean; claim: PageClaim | null } | null> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const block = blockId(input.blockId);
    const pullRequestUrl = input.pullRequestUrl.slice(0, 500);
    return this.inSpace(bounded(input.requestId, "requestId"), "page.claim.pull_request", spaceId, async (tx) => {
      const space = await tx.query<QueryResultRow & { owner_user_id: string }>({
        name: "page_claim_pull_request_space_v1", text: "SELECT owner_user_id FROM data.spaces WHERE space_id=$1",
        values: [spaceId], maxRows: 1 });
      if (!space[0]) return null;
      const pages = await tx.query<QueryResultRow & Pick<PageRow, "page_id" | "parent_page_id" | "access_mode" | "title">>({
        name: "page_claim_pull_request_tree_v1",
        text: `SELECT page_id,parent_page_id,access_mode,title FROM data.pages WHERE space_id=$1
          ORDER BY page_id LIMIT ${MAX_PAGES + 1}`, values: [spaceId], maxRows: MAX_PAGES + 1 });
      const page = pages.find((row) => row.page_id === pageId);
      const claim = !page || input.ownerUserId === null ? undefined
        : (await this.activeClaims(tx, spaceId, pageId, block, bounded(input.ownerUserId, "ownerUserId")))[0];
      if (claim) {
        await tx.query({ name: "page_claim_pull_request_record_v1",
          text: "UPDATE data.page_claims SET pull_request_url=$3, updated_at=now() WHERE space_id=$1 AND claim_id=$2",
          values: [spaceId, claim.claimId, pullRequestUrl], maxRows: 0 });
      }
      return { spaceOwnerUserId: space[0].owner_user_id, pageTitle: page?.title ?? null,
        restricted: !openToEveryMember(pages, pageId), claim: claim ? { ...claim, pullRequestUrl } : null };
    });
  }

  /** A merged pull request completes the claims whose work it did. */
  async completePullRequestClaims(input: { requestId: string; spaceId: string; pullRequestUrl: string }):
    Promise<{ completed: Array<{ pageId: string; pageTitle: string | null; blockId: string;
      conversationId: string | null; ownerUserId: string }> }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.claim.complete", spaceId, async (tx) => {
      const rows = await tx.query<QueryResultRow & { page_id: string; block_id: string; conversation_id: string | null;
        owner_user_id: string; title: string | null }>({
        name: "page_claims_complete_v2",
        text: `WITH completed AS (
            UPDATE data.page_claims SET state='completed', updated_at=now()
            WHERE space_id=$1 AND pull_request_url=$2 AND state='active'
            RETURNING page_id, block_id, conversation_id, owner_user_id)
          SELECT c.page_id, c.block_id, c.conversation_id, c.owner_user_id, p.title
          FROM completed c LEFT JOIN data.pages p ON p.space_id=$1 AND p.page_id=c.page_id`,
        values: [spaceId, input.pullRequestUrl.slice(0, 500)], maxRows: MAX_LINKS,
      });
      return { completed: rows.map((row) => ({ pageId: row.page_id, pageTitle: row.title, blockId: row.block_id,
        conversationId: row.conversation_id, ownerUserId: row.owner_user_id })) };
    });
  }

  private async activeClaims(tx: DatabaseTransaction, spaceId: string, pageId: string, block?: string,
    ownerUserId?: string):
    Promise<PageClaim[]> {
    const rows = await tx.query<QueryResultRow & { claim_id: string; block_id: string; holder_kind: "user" | "agent";
      holder_id: string; holder_label: string; owner_user_id: string; conversation_id: string | null;
      pull_request_url: string | null; expires_at: Date | string; created_at: Date | string }>({
      name: "page_claims_active_v2",
      text: `SELECT claim_id,block_id,holder_kind,holder_id,holder_label,owner_user_id,conversation_id,
          pull_request_url,expires_at,created_at
        FROM data.page_claims WHERE space_id=$1 AND page_id=$2 AND ($3::text IS NULL OR block_id=$3)
          AND ($4::text IS NULL OR owner_user_id=$4) AND state='active' AND expires_at > now()
        ORDER BY created_at, claim_id LIMIT ${MAX_LINKS}`,
      values: [spaceId, pageId, block ?? null, ownerUserId ?? null], maxRows: MAX_LINKS,
    });
    return rows.map((row) => ({
      claimId: row.claim_id, pageId, blockId: row.block_id,
      holder: { kind: row.holder_kind, id: row.holder_id, label: row.holder_label },
      ownerUserId: row.owner_user_id, conversationId: row.conversation_id, pullRequestUrl: row.pull_request_url,
      expiresAt: iso(row.expires_at), createdAt: iso(row.created_at),
    }));
  }

  /**
   * The pages a reader may read and their revisions, for the reader's git
   * view (docs/design/pages-and-conversations.md §5.4). A page the reader
   * cannot read contributes nothing, not even history.
   */
  async gitView(input: { requestId: string; spaceId: string; principal: PagePrincipal }): Promise<{
    pages: Array<{ pageId: string; parentPageId: string | null; title: string; position: string }>;
    revisions: Array<{ pageId: string; revision: number; body: string; authors: PageAuthor[];
      conversationIds: string[]; createdAt: string }>;
  }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.git.view", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const readable = await this.accessibleTree(tx, spaceId, actor);
      const rows = readable.length === 0 ? [] : await tx.query<RevisionRow & { page_id: string }>({
        name: "page_git_revisions_v1",
        text: `SELECT page_id,revision,kind,body,authors_json,conversation_ids,based_on_revision,created_at
          FROM data.page_revisions WHERE space_id=$1 AND page_id = ANY($2::text[])
          ORDER BY created_at, page_id, revision LIMIT ${MAX_GIT_REVISIONS + 1}`,
        values: [spaceId, readable.map((row) => row.page_id)], maxRows: MAX_GIT_REVISIONS + 1,
      });
      if (rows.length > MAX_GIT_REVISIONS) {
        throw new PageControlError("page_history_too_large", 409, "This Space's page history is too long to serve as git");
      }
      return {
        pages: readable.map((row) => ({ pageId: row.page_id, parentPageId: row.parent_page_id, title: row.title,
          position: row.position })),
        revisions: rows.map((row) => ({ pageId: row.page_id, revision: Number(row.revision), body: row.body ?? "",
          authors: revisionOf(row).authors, conversationIds: row.conversation_ids ?? [], createdAt: iso(row.created_at) })),
      };
    });
  }

  /** A published page as anyone reads it; a page that is not public reads as not found. */
  async publicRead(input: { requestId: string; spaceId: string; pageId: string }): Promise<{ page: PublicPage }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.public.read", spaceId, async (tx) => {
      const rows = await tx.query<PageRow>({
        name: "page_public_tree_v1",
        text: `SELECT page_id,parent_page_id,title,position,access_mode,head_revision,
            agent_suggest_only,updated_at,version,published_at
          FROM data.pages WHERE space_id=$1 ORDER BY position, page_id LIMIT ${MAX_PAGES + 1}`,
        values: [spaceId], maxRows: MAX_PAGES + 1,
      });
      const isPublic = (row: PageRow | undefined): row is PageRow =>
        row !== undefined && row.published_at !== null && openToEveryMember(rows, row.page_id);
      const row = rows.find((item) => item.page_id === pageId);
      if (!isPublic(row)) throw new PageControlError("page_not_found", 404);
      const head = await tx.query<RevisionRow>({
        name: "page_public_revision_v1",
        text: `SELECT revision,kind,body,authors_json,conversation_ids,based_on_revision,created_at
          FROM data.page_revisions WHERE space_id=$1 AND page_id=$2 AND revision=$3`,
        values: [spaceId, pageId, Number(row.head_revision)], maxRows: 1,
      });
      const space = await tx.query<QueryResultRow & { name: string; open_to_join: boolean | null }>({
        name: "page_public_space_v2",
        text: "SELECT name, (metadata_json->>'openParticipation')::boolean AS open_to_join FROM data.spaces WHERE space_id=$1",
        values: [spaceId], maxRows: 1,
      });
      const revision = head[0];
      if (!revision) throw new PageControlError("page_not_found", 404);
      return { page: {
        spaceId, spaceName: space[0]?.name ?? "", pageId, title: row.title, body: revision.body ?? "",
        headRevision: Number(row.head_revision), updatedAt: iso(row.updated_at),
        authors: revisionOf(revision).authors.map((author) => ({ kind: author.kind, label: author.label })),
        children: rows.filter((child) => child.parent_page_id === pageId && isPublic(child))
          .map((child) => ({ pageId: child.page_id, title: child.title })),
        openToJoin: space[0]?.open_to_join === true,
      } };
    });
  }

  async remove(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal }):
    Promise<{ removed: boolean; automationChannels: string[] }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.remove", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      this.requireStructure(actor);
      await this.page(tx, spaceId, actor, pageId, "edit");
      const child = await tx.query({ name: "page_has_child_v1",
        text: "SELECT 1 FROM data.pages WHERE space_id=$1 AND parent_page_id=$2 LIMIT 1",
        values: [spaceId, pageId], maxRows: 1 });
      if (child.length) throw new PageControlError("page_has_children", 409, "Move or remove its child pages first");
      for (const table of ["data.page_links", "data.page_access", "data.page_reads", "data.page_revisions"]) {
        await tx.query({ name: `page_remove_${table.slice(5)}_v1`,
          text: `DELETE FROM ${table} WHERE space_id=$1 AND page_id=$2`, values: [spaceId, pageId], maxRows: 0 });
      }
      const automationChannels = await removePageAutomations(tx, { spaceId, pageId, at: new Date().toISOString() });
      const removed = await tx.query({ name: "page_remove_v1",
        text: "DELETE FROM data.pages WHERE space_id=$1 AND page_id=$2 RETURNING page_id",
        values: [spaceId, pageId], maxRows: 1 });
      return { removed: removed.length === 1, automationChannels };
    });
  }

  /**
   * Removes content from every revision of a page without rewriting anyone
   * else's history: each affected revision's body is replaced by the caller's
   * redacted text and a purge revision records who did it. Owners/admins only.
   */
  async purge(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    needle: string; replacement?: string }): Promise<{ redactedRevisions: number }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const needle = bounded(input.needle, "needle", 10_000);
    const replacement = input.replacement ?? "[redacted]";
    return this.inSpace(bounded(input.requestId, "requestId"), "page.purge", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      if (actor.role !== "owner" && actor.role !== "admin") {
        throw new PageControlError("page_purge_admin_only", 403);
      }
      await this.page(tx, spaceId, actor, pageId, "read");
      // One count row: query results are capped at 10000 rows and a page may have more revisions.
      const rows = await tx.query<QueryResultRow & { n: number }>({
        name: "page_purge_v2",
        text: `WITH redacted AS (UPDATE data.page_revisions SET body=replace(body,$3,$4)
          WHERE space_id=$1 AND page_id=$2 AND strpos(body,$3) > 0 RETURNING 1) SELECT count(*)::int AS n FROM redacted`,
        values: [spaceId, pageId, needle, replacement], maxRows: 1,
      });
      return { redactedRevisions: Number(rows[0]?.n ?? 0) };
    });
  }

  /** Links require that the actor (and, for an Agent, its owner) may read both sides. */
  private async recordLink(tx: DatabaseTransaction, spaceId: string, actor: Actor, principal: PagePrincipal,
    input: { conversationId: string; pageId: string; blockId: string; source: PageLink["source"];
      anchor?: PageLinkAnchor | null }): Promise<PageLink> {
    const conversationId = bounded(input.conversationId, "conversationId");
    const anchor = input.anchor ? linkAnchor(input.anchor) : null;
    const readers = principal.kind === "agent"
      ? [{ kind: "agent" as const, id: principal.id }, { kind: "user" as const, id: actor.userId }]
      : [{ kind: "user" as const, id: actor.userId }];
    for (const reader of readers) {
      await requireChannelCapability(tx, { capability: "message_content_read", channelId: conversationId,
        spaceId, principal: reader,
        error: (failure) => new PageControlError(failure.code, failure.status) });
    }
    const now = new Date().toISOString();
    const row = (await tx.query<LinkRow>({
      name: "page_link_upsert_v2",
      text: `INSERT INTO data.page_links (space_id,link_id,conversation_id,page_id,block_id,source,
          created_by_kind,created_by_id,created_at,last_seen_at,anchor_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10::jsonb)
        ON CONFLICT (space_id,conversation_id,page_id,block_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,
          anchor_json=COALESCE(EXCLUDED.anchor_json, data.page_links.anchor_json)
        RETURNING ${LINK_COLUMNS}`,
      values: [spaceId, crypto.randomUUID(), conversationId, input.pageId, input.blockId, input.source,
        principal.kind, principal.id, now, anchor ? JSON.stringify(anchor) : null],
      maxRows: 1,
    }))[0]!;
    return linkOf(row);
  }

  /**
   * A discussion is resolved once its outcome is in the page, or reopened.
   * Whoever may edit the page does it, people and Agents alike.
   */
  async resolveLink(input: { requestId: string; spaceId: string; principal: PagePrincipal; linkId: string;
    resolved: boolean }): Promise<{ link: PageLink }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const linkId = bounded(input.linkId, "linkId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.link.resolve", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const found = (await tx.query<LinkRow>({
        name: "page_link_get_v1",
        text: `SELECT ${LINK_COLUMNS} FROM data.page_links WHERE space_id=$1 AND link_id=$2`,
        values: [spaceId, linkId], maxRows: 1,
      }))[0];
      if (!found) throw new PageControlError("page_link_not_found", 404);
      await this.page(tx, spaceId, actor, found.page_id, "edit");
      const row = (await tx.query<LinkRow>({
        name: "page_link_resolve_v1",
        text: `UPDATE data.page_links SET resolved_at=CASE WHEN $3 THEN COALESCE(resolved_at, now()) END
          WHERE space_id=$1 AND link_id=$2 RETURNING ${LINK_COLUMNS}`,
        values: [spaceId, linkId, input.resolved], maxRows: 1,
      }))[0]!;
      return { link: linkOf(row) };
    });
  }

  async link(input: { requestId: string; spaceId: string; principal: PagePrincipal; conversationId: string;
    pageId: string; blockId?: string; source: "jev" | "reference" | "manual" | "migration";
    anchor?: PageLinkAnchor | null }): Promise<{ link: PageLink }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    if (!["jev", "reference", "manual", "migration"].includes(input.source)) {
      throw new PageControlError("invalid_request", 400, "source is invalid");
    }
    return this.inSpace(bounded(input.requestId, "requestId"), "page.link", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      await this.page(tx, spaceId, actor, pageId, "read");
      return { link: await this.recordLink(tx, spaceId, actor, input.principal,
        { conversationId: input.conversationId, pageId, blockId: blockId(input.blockId), source: input.source,
          anchor: input.anchor ?? null }) };
    });
  }

  /**
   * Links the pages a message refers to, as its author. References to pages
   * that do not exist or that the author cannot read are ignored: a
   * reference never grants anything.
   */
  /**
   * A Run says its work changed nothing more on the pages (`xmatrix page
   * done`): the sections its conversation's ended claims left owing an
   * update no longer owe one (pages-live-document.md §5).
   */
  async settleWriteback(input: { requestId: string; conversationId: string; principal: PagePrincipal }):
    Promise<{ settled: number }> {
    const conversationId = bounded(input.conversationId, "conversationId");
    const requestId = bounded(input.requestId, "requestId");
    const route = await new PostgresChannelSpaceDirectory(this.database).resolve(
      { requestId, operation: "page.writeback.resolve" }, conversationId);
    if (!route) return { settled: 0 };
    return this.inSpace(requestId, "page.writeback.settle", route.spaceId, async (tx) => {
      const actor = await pageActor(tx, route.spaceId, input.principal, false);
      const readers = input.principal.kind === "agent"
        ? [{ kind: "agent" as const, id: input.principal.id }, { kind: "user" as const, id: actor.userId }]
        : [{ kind: "user" as const, id: actor.userId }];
      for (const reader of readers) {
        await requireChannelCapability(tx, { capability: "message_content_read", channelId: conversationId,
          spaceId: route.spaceId, principal: reader, error: (failure) => new PageControlError(failure.code, failure.status) });
      }
      const rows = await tx.query<QueryResultRow & { claim_id: string }>({
        name: "page_claims_settle_writeback_v1",
        text: `UPDATE data.page_claims SET written_back_at=now()
          WHERE space_id=$1 AND conversation_id=$2 AND written_back_at IS NULL
            AND (state IN ('completed','released') OR (state='active' AND expires_at <= now()))
          RETURNING claim_id`,
        values: [route.spaceId, conversationId], maxRows: MAX_LINKS,
      });
      return { settled: rows.length };
    });
  }

  async linkReferences(input: { requestId: string; conversationId: string; principal: PagePrincipal;
    pageIds: string[] }): Promise<{ linked: string[] }> {
    const pageIds = [...new Set(input.pageIds)].filter((id) => /^[0-9a-f-]{36}$/u.test(id)).slice(0, 10);
    if (pageIds.length === 0) return { linked: [] };
    const conversationId = bounded(input.conversationId, "conversationId");
    const requestId = bounded(input.requestId, "requestId");
    const route = await new PostgresChannelSpaceDirectory(this.database).resolve(
      { requestId, operation: "page.references.resolve" }, conversationId);
    if (!route) return { linked: [] };
    return this.inSpace(requestId, "page.references", route.spaceId, async (tx) => {
      const actor = await pageActor(tx, route.spaceId, input.principal, false);
      const readable = new Set((await this.accessibleTree(tx, route.spaceId, actor)).map((row) => row.page_id));
      const linked: string[] = [];
      for (const pageId of pageIds) {
        if (!readable.has(pageId)) continue;
        await this.recordLink(tx, route.spaceId, actor, input.principal,
          { conversationId, pageId, blockId: "", source: "reference" });
        linked.push(pageId);
      }
      return { linked };
    });
  }

  async unlink(input: { requestId: string; spaceId: string; principal: PagePrincipal; linkId: string }):
    Promise<{ removed: boolean }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.unlink", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      const link = (await tx.query<QueryResultRow & { page_id: string; conversation_id: string }>({
        name: "page_link_find_v1",
        text: "SELECT page_id, conversation_id FROM data.page_links WHERE space_id=$1 AND link_id=$2",
        values: [spaceId, bounded(input.linkId, "linkId")], maxRows: 1,
      }))[0];
      if (!link) return { removed: false };
      await this.page(tx, spaceId, actor, link.page_id, "read");
      await requireChannelCapability(tx, { capability: "message_active_command", channelId: link.conversation_id,
        spaceId, principal: { kind: "user", id: actor.userId },
        error: (failure) => new PageControlError(failure.code, failure.status) });
      const rows = await tx.query({ name: "page_link_remove_v1",
        text: "DELETE FROM data.page_links WHERE space_id=$1 AND link_id=$2 RETURNING link_id",
        values: [spaceId, input.linkId], maxRows: 1 });
      return { removed: rows.length === 1 };
    });
  }

  /** Links of one page (for its presence gutter) or of one conversation (for its header). */
  async links(input: { requestId: string; spaceId: string; principal: PagePrincipal;
    pageId?: string; conversationId?: string }): Promise<{ links: PageLink[] }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    if (!input.pageId === !input.conversationId) {
      throw new PageControlError("invalid_request", 400, "name exactly one of pageId or conversationId");
    }
    return this.inSpace(bounded(input.requestId, "requestId"), "page.links", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const readable = new Set((await this.accessibleTree(tx, spaceId, actor)).map((row) => row.page_id));
      if (input.pageId && !readable.has(input.pageId)) throw new PageControlError("page_not_found", 404);
      if (input.conversationId) {
        await requireChannelCapability(tx, { capability: "message_content_read",
          channelId: bounded(input.conversationId, "conversationId"), spaceId,
          principal: { kind: "user", id: actor.userId },
          error: (failure) => new PageControlError(failure.code, failure.status) });
      }
      const rows = await linkRows(tx, spaceId, input.pageId ?? null, input.conversationId ?? null);
      // A link grants nothing: only links whose page this reader may open are
      // returned, and for a page listing only conversations the reader may open.
      const visible = new Set(input.pageId ? (await tx.query<QueryResultRow & { channel_id: string }>({
        name: "page_link_conversations_visible_v1",
        text: `SELECT c.channel_id FROM data.channels c WHERE c.space_id=$1 AND c.channel_id = ANY($2::text[])
          AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
            principalKindSql: "'user'", principalIdSql: "$3" })}`,
        values: [spaceId, [...new Set(rows.map((row) => row.conversation_id))], actor.userId],
        maxRows: MAX_LINKS,
      })).map((row) => row.channel_id) : rows.map((row) => row.conversation_id));
      const out: PageLink[] = rows
        .filter((row) => readable.has(row.page_id) && visible.has(row.conversation_id))
        .map(linkOf);
      return { links: out };
    });
  }

  /**
   * The Agents on each page now, for the page tree and the page itself:
   * every Agent live in a conversation whose current Run read or edited the
   * page (its link was seen after the Instance started), with the section it
   * last touched; and each page's open discussions, newest first. Derived,
   * never stored; only pages and conversations this reader may open are
   * described.
   */
  async agentsOnPages(input: { requestId: string; spaceId: string; principal: PagePrincipal }):
    Promise<{ pages: Array<{ pageId: string; agents: PageTreeAgent[]; discussions: string[] }> }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.agents", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const tree = await this.accessibleTree(tx, spaceId, actor);
      const readable = new Set(tree.map((row) => row.page_id));
      const rows = await tx.query<QueryResultRow & { page_id: string; conversation_id: string; block_id: string;
        last_seen_at: string | Date; source: string }>({
        name: "page_agents_v2",
        text: `SELECT DISTINCT ON (pl.page_id, pl.conversation_id) pl.page_id, pl.conversation_id, pl.block_id,
            pl.last_seen_at, pl.source
          FROM data.page_links pl
          JOIN data.channels c ON c.space_id=pl.space_id AND c.channel_id=pl.conversation_id
          WHERE pl.space_id=$1 AND pl.source IN ('read','edit')
            AND EXISTS (SELECT 1 FROM data.instances i
              JOIN data.runs r ON r.run_id=i.run_id AND r.channel_id=i.channel_id
              WHERE i.channel_id=pl.conversation_id AND i.status IN (${LIVE_AGENT_STATUS_SQL})
                AND r.status IN ('running','stopping') AND i.created_at<=pl.last_seen_at)
            AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
              principalKindSql: "'user'", principalIdSql: "$2" })}
          ORDER BY pl.page_id, pl.conversation_id, pl.last_seen_at DESC
          LIMIT ${MAX_LINKS}`,
        values: [spaceId, actor.userId], maxRows: MAX_LINKS,
      });
      // A discussion is open until its outcome is written into the page; the others wait on nobody.
      const open = await tx.query<QueryResultRow & { page_id: string; conversation_id: string }>({
        name: "page_open_discussions_v1",
        text: `SELECT pl.page_id, pl.conversation_id, max(pl.last_seen_at) AS seen
          FROM data.page_links pl
          JOIN data.channels c ON c.space_id=pl.space_id AND c.channel_id=pl.conversation_id
          WHERE pl.space_id=$1 AND pl.anchor_json IS NOT NULL AND pl.resolved_at IS NULL
            AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
              principalKindSql: "'user'", principalIdSql: "$2" })}
          GROUP BY pl.page_id, pl.conversation_id
          ORDER BY seen DESC
          LIMIT ${MAX_LINKS}`,
        values: [spaceId, actor.userId], maxRows: MAX_LINKS,
      });
      const discussionsOf = new Map<string, string[]>();
      for (const row of open.filter((item) => readable.has(item.page_id))) {
        discussionsOf.set(row.page_id, [...(discussionsOf.get(row.page_id) ?? []), row.conversation_id]);
      }
      const visible = rows.filter((row) => readable.has(row.page_id));
      const presence = await loadChannelAgentPresence(tx, spaceId, visible.map((row) => row.conversation_id));
      const byPage = new Map<string, PageTreeAgent[]>();
      for (const row of visible) {
        const seenAt = Date.parse(iso(row.last_seen_at));
        for (const member of Object.values(presence.get(row.conversation_id) ?? {})) {
          if (member.kind !== "agent") continue;
          for (const instance of member.instances ?? []) {
            // A sleeping Instance is not on the page; an earlier Run in the
            // same conversation read the page, not this one.
            const status = instance.status;
            if (!isLiveAgentStatus(status) || Date.parse(instance.connectedAt) > seenAt) continue;
            const agents = byPage.get(row.page_id) ?? [];
            agents.push({ instanceId: instance.id, name: instance.label || member.label || "Agent",
              status,
              ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
              conversationId: row.conversation_id, activity: row.source === "edit" ? "editing" : "viewing",
              blockId: row.block_id });
            byPage.set(row.page_id, agents);
          }
        }
      }
      // The section an Agent is in, by its heading, read from the page's head.
      const sectioned = tree.filter((row) => byPage.get(row.page_id)?.some((agent) => agent.blockId));
      if (sectioned.length > 0) {
        const heads = await tx.query<QueryResultRow & { page_id: string; body: string | null }>({
          name: "page_agent_sections_v1",
          text: `SELECT r.page_id, r.body FROM data.page_revisions r
            JOIN unnest($2::text[], $3::bigint[]) AS head(page_id, revision)
              ON r.page_id=head.page_id AND r.revision=head.revision
            WHERE r.space_id=$1`,
          values: [spaceId, sectioned.map((row) => row.page_id), sectioned.map((row) => String(row.head_revision))],
          maxRows: sectioned.length,
        });
        for (const head of heads) {
          const titles = new Map(pageBlocks(canonicalPageMarkdown(head.body ?? "")).map((block) => [block.id, block.title]));
          for (const agent of byPage.get(head.page_id) ?? []) {
            const section = agent.blockId ? titles.get(agent.blockId) : undefined;
            if (section) agent.section = section;
          }
        }
      }
      const pageIds = new Set([...byPage.keys(), ...discussionsOf.keys()]);
      return { pages: [...pageIds].map((pageId) => ({ pageId, agents: byPage.get(pageId) ?? [],
        discussions: discussionsOf.get(pageId) ?? [] })) };
    });
  }
}

/** Whether no page from this one up to the root is restricted, so every member reads it. */
function openToEveryMember(rows: ReadonlyArray<Pick<PageRow, "page_id" | "parent_page_id" | "access_mode">>,
  pageId: string): boolean {
  const byId = new Map(rows.map((row) => [row.page_id, row]));
  for (let current = byId.get(pageId), depth = 0; current; depth++) {
    if (current.access_mode === "restricted" || depth > MAX_DEPTH) return false;
    current = current.parent_page_id ? byId.get(current.parent_page_id) : undefined;
  }
  return byId.has(pageId);
}

function validAuthor(value: PageAuthor): PageAuthor {
  if (!value || (value.kind !== "user" && value.kind !== "agent") || typeof value.id !== "string" ||
      !value.id || value.id.length > 300 || typeof value.label !== "string") {
    throw new PageControlError("invalid_request", 400, "coAuthors are invalid");
  }
  return { kind: value.kind, id: value.id, label: value.label.slice(0, 200),
    ...(typeof value.ownerUserId === "string" ? { ownerUserId: value.ownerUserId } : {}) };
}

function dedupeAuthors(authors: PageAuthor[]): PageAuthor[] {
  const seen = new Set<string>();
  return authors.filter((author) => {
    const key = `${author.kind}:${author.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 64);
}
