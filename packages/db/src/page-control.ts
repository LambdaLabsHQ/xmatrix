import type { QueryResultRow } from "pg";
import { LIVE_AGENT_STATUS_SQL, isLiveAgentStatus, pageBlockAt, pageBlocks, pageChangeGist, utf8ByteLength } from "@xmatrix/protocol";
import { canonicalPageMarkdown } from "@xmatrix/protocol/page-document";
import { spaceBilling } from "@xmatrix/billing";
import { readsOnly } from "./space-roles.js";
import { MessageAuthorityError } from "./message-authority-error.js";
import { ControlError } from "./control-error.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { singleReadStatements } from "./single-read-statements.js";
import { channelCapabilityPredicate, requireChannelCapability } from "./channel-capability-policy.js";
import { loadChannelAgentPresence } from "./channel-agent-presence.js";
import { requireAgentChannelAccess, type AgentChannelRunProof } from "./agent-channel-access.js";
import { PostgresChannelSpaceDirectory, PostgresSpacePlacementDirectory } from "./placement.js";
import { reconcilePageAutomations, removePageAutomations } from "./automation-page-anchor.js";
import { keepSectionChanges, readRevisionBodies, walkSectionChanges, type SectionRevisionRow } from "./page-section-changes.js";
import { keepBlames, walkBlame, type BlameRevisionRow } from "./page-blame.js";
import type {
  PageAuthor, PageAutomationAnchorChange, PageBlame, PageBlockAwareness, PageDocument, PageLink, PageLinkAnchor, PageMessageEdit, PageRecentChange, PageRevision, PageRevisionMoment, PageSearchHit, PageSummary, PageTreeAgent, PublicPage,
} from "@xmatrix/protocol";

export type { PageAuthor, PageDocument, PageLink, PageRevision, PageSummary, PublicPage };

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
  | { kind: "user"; id: string; label?: string; application?: PageAuthor["application"] }
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
/** How far back a section's last change is looked for; older changes read as unknown. */
const BLOCK_UPDATE_REVISIONS = 30;
/** Conversations a page's blame names, the newest revisions' first. */
const MAX_BLAME_CONVERSATIONS = 200;
/** Suggestions older than this no longer wait on the page; History still has them. */
const SUGGESTION_WAIT_DAYS = 14;
/** At most this many suggestions wait on a page at once. */
const MAX_WAITING_SUGGESTIONS = 20;
/** Recent changes the Pages list shows, and at most when asked for more. */
const RECENT_CHANGES = 3;
const MAX_RECENT_CHANGES = 10;
const RECENT_CHANGE_SPARES = 4;
const MAX_LINKS = 500;
const MAX_CONVERSATION_PAGES = 20;
/** The messages one read of their page edits may name, as a timeline shows them. */
const MAX_PAGE_EDIT_MESSAGES = 100;
const MAX_PAGE_EDIT_REVISIONS = 2000;
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

/** What a page is called while its document does not open with a name. */
export const UNNAMED_PAGE = "Untitled";

/**
 * A page's name is the top-level heading its document opens with
 * (pages-live-document.md §4.1): one datum, kept in the document and nowhere
 * else. `data.page_name` reads it the same way in SQL.
 */
export function pageNameFrom(body: string): string | null {
  const line = body.trimStart().split("\n", 1)[0]?.trim() ?? "";
  return /^#[ \t]+(\S.*)$/u.exec(line)?.[1]?.trim() ?? null;
}

/** A document that opens with a name: its own, or `name` above it. */
export function namedPageBody(body: string, name: string): string {
  if (pageNameFrom(body) !== null) return body;
  const heading = `# ${pageTitle(name)}\n`;
  return body.trim() ? `${heading}\n${body.replace(/^\s*\n/u, "")}` : heading;
}

/** The same document under another name: the heading it opens with is rewritten, or added. */
export function renamedPageBody(body: string, name: string): string {
  const heading = `# ${pageTitle(name)}`;
  if (pageNameFrom(body) === null) return namedPageBody(body, name);
  const start = body.length - body.trimStart().length;
  const end = body.indexOf("\n", start);
  return `${body.slice(0, start)}${heading}${end < 0 ? "\n" : body.slice(end)}`;
}

/** A page row joined to its head revision, whose document carries the page's name. */
const HEAD_REVISION = `LEFT JOIN data.page_revisions r
  ON r.space_id=p.space_id AND r.page_id=p.page_id AND r.revision=p.head_revision`;

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

/**
 * The section whose text contains the query, or a title hit when only the page's name does: the
 * name is the heading its document opens with, so a match on that line is a title hit. Body wins.
 */
function pageSearchHit(title: string, body: string, pageId: string, query: string): PageSearchHit {
  const needle = query.toLocaleLowerCase();
  const nameLine = body.length - body.trimStart().length;
  const afterName = pageNameFrom(body) === null ? 0 : (body.indexOf("\n", nameLine) + 1 || body.length);
  const bodyAt = body.toLocaleLowerCase().indexOf(needle, afterName);
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
  page_id: string; parent_page_id: string | null; title: string | null; position: string;
  access_mode: "open" | "restricted"; head_revision: string | number; agent_suggest_only: boolean;
  updated_at: Date | string; version: string | number; published_at: Date | string | null;
  summary?: string | null; summary_revision?: string | number | null; summary_at?: Date | string | null;
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

/** A conversation co-writing a page, named by the person starting or ending it. */
interface CoWritingInput {
  requestId: string; spaceId: string; pageId: string; principal: PagePrincipal; conversationId: string;
}

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
      : { kind: "user", id: principal.id, label,
        ...(principal.application ? { application: principal.application } : {}) },
  };
}

/** Resolves the Space's active shard for both transactional work and independent reads. */
async function activeSpaceContext(database: AuthorityDatabase,
  input: { requestId: string; operation: string; spaceId: string },
  ErrorType: new (code: string, status: number) => Error) {
  const { requestId, operation, spaceId } = input;
  const placement = await new PostgresSpacePlacementDirectory(database).find({ requestId, operation }, spaceId);
  if (!placement) throw new ErrorType("space_not_found", 404);
  if (placement.state !== "active" || placement.targetShardId !== null) {
    // A Space that is moving shards is back in moments: say so, whichever
    // domain asked, so every client retries it like the other controls do.
    throw new ControlError("space_placement_unavailable", 503, "Space placement is unavailable", true);
  }
  return { requestId, operation,
    placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch } };
}

/** Runs a transaction on the Space's shard, which must not be moving. */
export async function inActiveSpace<T>(database: AuthorityDatabase,
  input: { requestId: string; operation: string; spaceId: string },
  ErrorType: new (code: string, status: number) => Error,
  callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
  return database.transaction(await activeSpaceContext(database, input, ErrorType), callback);
}

/** A page as one actor sees it: their access, and whether it is the Space's governance page. */
type TreeRow = PageRow & AccessView & { governance: boolean };

/** Every page in the Space with the actor's effective access, parents first. */
async function accessibleTree(tx: DatabaseTransaction, spaceId: string, actor: Actor): Promise<TreeRow[]> {
  // One statement: each page with the actor's own grant on it and whether it is the Space's governance page.
  // Every page request checks access through here, so its round trips are paid on every one.
  const rows = await tx.query<PageRow & { actor_access: "read" | "edit" | null; is_governance: boolean }>({
    name: "page_tree_access_v1",
    text: `SELECT p.page_id,p.parent_page_id,data.page_name(r.body) AS title,p.position,p.access_mode,
        p.head_revision,p.agent_suggest_only,p.updated_at,p.version,p.published_at,p.summary,p.summary_revision,
        p.summary_at,
        (SELECT a.access FROM data.page_access a WHERE a.space_id=p.space_id AND a.page_id=p.page_id
          AND a.subject_kind='user' AND a.subject_id=$2) AS actor_access,
        COALESCE(p.page_id=(SELECT s.metadata_json->>'governancePageId' FROM data.spaces s WHERE s.space_id=$1),
          false) AS is_governance
      FROM data.pages p ${HEAD_REVISION}
      WHERE p.space_id=$1 ORDER BY p.parent_page_id NULLS FIRST, p.position, p.page_id
      LIMIT ${MAX_PAGES + 1}`,
    values: [spaceId, actor.userId], maxRows: MAX_PAGES + 1,
  });
  if (rows.length > MAX_PAGES) throw new PageControlError("page_tree_too_large", 409);
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
      const own = row.actor_access ?? undefined;
      view = { canRead: admin || own !== undefined, canEdit: admin || own === "edit" };
    } else if (row.parent_page_id) view = resolve(row.parent_page_id, depth + 1);
    else view = { canRead: true, canEdit: !readsOnly(actor.role) };
    memo.set(pageId, view);
    return view;
  };
  // The Space's governance page is its maintainers' to edit (open-project-governance.md §4).
  return rows.map(({ actor_access: _access, is_governance: governance, ...row }) => {
    const view = resolve(row.page_id);
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

export interface PageRepositoryOptions {
  /** The deployment's own operator Space, which is not charged Agent credits. */
  creditsWaivedSpaceId?: string;
}

export class PostgresPageRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly options: PageRepositoryOptions = {}) {
    if (database.cacheMode !== "disabled") throw new PageControlError("cached_authority_forbidden", 500);
  }

  /**
   * A page revision counts toward a Free Space's allowance, whoever wrote it,
   * and an Agent's uses a paid Space's credit (docs/design/agent-credits.md).
   */
  private async chargeRevision(tx: DatabaseTransaction, spaceId: string, actor: Actor, now: string): Promise<void> {
    const rejection = await spaceBilling.durableWrite(tx, { spaceId, now, kind: "page_revision",
      author: actor.isAgent ? "agent" : "person", creditsWaived: spaceId === this.options.creditsWaivedSpaceId });
    if (rejection) throw new PageControlError(rejection.code, rejection.status, rejection.message, rejection.details);
  }

  private inSpace<T>(requestId: string, operation: string, spaceId: string,
    callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return inActiveSpace(this.database, { requestId, operation, spaceId }, PageControlError, callback);
  }

  /** Lock-free activity reads retain READ COMMITTED's per-statement snapshots and placement fences. */
  private async readInSpace<T>(requestId: string, operation: string, spaceId: string,
    callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    const session = this.database.openSession();
    try {
      const context = await activeSpaceContext(session, { requestId, operation, spaceId }, PageControlError);
      return await callback(singleReadStatements(session, context));
    } finally {
      await session.close();
    }
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
      pageId: row.page_id, parentPageId: row.parent_page_id, title: row.title ?? UNNAMED_PAGE, position: row.position,
      accessMode: row.access_mode, headRevision: Number(row.head_revision),
      agentSuggestOnly: row.agent_suggest_only,
      canEdit: row.canEdit,
      updatedAt: iso(row.updated_at),
      publishedAt: row.published_at === null ? null : iso(row.published_at),
      governance: row.governance,
      summary: row.summary && row.summary_revision && row.summary_at
        ? { text: row.summary, revision: Number(row.summary_revision), at: iso(row.summary_at) } : null,
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

  /**
   * What each of an Agent's messages in a conversation follows on pages: the revisions its Instance committed from
   * that conversation after its previous message, up to this one. A message shows them, as a tool call shows what
   * it did; nothing else is said in the conversation. Only pages the reader can open are named.
   */
  async conversationPageEdits(input: { requestId: string; conversationId: string; messageIds: readonly string[];
    principal: PagePrincipal }): Promise<{ spaceId: string; edits: PageMessageEdit[] }> {
    const messageIds = [...new Set(input.messageIds.map((id) => bounded(id, "messageId")))];
    if (messageIds.length > MAX_PAGE_EDIT_MESSAGES) {
      throw new PageControlError("invalid_request", 400, `at most ${MAX_PAGE_EDIT_MESSAGES} messages`);
    }
    return this.inConversation(input, "page.conversation.edits", async (tx, spaceId, actor) => {
      if (messageIds.length === 0) return { spaceId, edits: [] };
      const edited = new Set((await linkRows(tx, spaceId, null, input.conversationId))
        .filter((link) => link.source === "edit").map((link) => link.page_id));
      if (edited.size === 0) return { spaceId, edits: [] };
      const tree = new Map((await this.accessibleTree(tx, spaceId, actor))
        .filter((row) => edited.has(row.page_id)).map((row) => [row.page_id, row]));
      if (tree.size === 0) return { spaceId, edits: [] };
      const rows = await tx.query<QueryResultRow & { message_id: string; page_id: string; revision: string;
        based_on_revision: string | null }>({
        name: "page_message_edits_v1",
        text: `WITH sent AS (
            SELECT message_id, author_id, sent_at FROM data.messages
            WHERE space_id=$1 AND channel_id=$2 AND message_id = ANY($3::text[]) AND author_kind='agent'
              AND message_kind='xmatrix.message.text' AND deleted_at IS NULL AND recalled_at IS NULL
          ), spans AS (
            SELECT sent.*, (SELECT before.sent_at FROM data.messages before
                WHERE before.space_id=$1 AND before.author_kind='agent' AND before.author_id=sent.author_id
                  AND before.sent_at < sent.sent_at AND before.channel_id=$2
                  AND before.message_kind='xmatrix.message.text' AND before.deleted_at IS NULL
                ORDER BY before.sent_at DESC LIMIT 1) AS since
            FROM sent
          )
          SELECT spans.message_id, r.page_id, r.revision::text, r.based_on_revision::text
          FROM spans JOIN data.page_revisions r ON r.space_id=$1 AND r.page_id = ANY($4::text[])
            AND $2 = ANY(r.conversation_ids) AND r.kind IN ('edit', 'accepted', 'restore')
            AND r.authors_json @> jsonb_build_array(jsonb_build_object('kind', 'agent', 'id', spans.author_id))
            AND r.created_at <= spans.sent_at AND (spans.since IS NULL OR r.created_at > spans.since)
          ORDER BY spans.message_id, r.page_id, r.revision
          LIMIT ${MAX_PAGE_EDIT_REVISIONS}`,
        values: [spaceId, input.conversationId, messageIds, [...tree.keys()]],
        maxRows: MAX_PAGE_EDIT_REVISIONS,
      });
      const edits = new Map<string, PageMessageEdit>();
      for (const row of rows) {
        const key = `${row.message_id}\u0000${row.page_id}`;
        let edit = edits.get(key);
        if (!edit) {
          edit = { messageId: row.message_id, pageId: row.page_id, title: this.summary(tree.get(row.page_id)!).title,
            revisions: [] };
          edits.set(key, edit);
        }
        edit.revisions.push({ revision: Number(row.revision),
          basedOnRevision: row.based_on_revision === null ? null : Number(row.based_on_revision) });
      }
      return { spaceId, edits: [...edits.values()] };
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
      // How far a person has read each page is theirs: an Agent Run has none.
      const reads = input.principal.kind !== "user" ? [] : await tx.query<QueryResultRow & { page_id: string; revision: string }>({
        name: "page_tree_reads_v1",
        text: `SELECT page_id, revision::text FROM data.page_reads WHERE space_id=$1 AND user_id=$2 LIMIT ${MAX_PAGES}`,
        values: [spaceId, actor.userId], maxRows: MAX_PAGES });
      const read = new Map(reads.map((row) => [row.page_id, Number(row.revision)]));
      return { pages: tree.map((row) => ({ ...this.summary(row), readRevision: read.get(row.page_id) ?? null })) };
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
      const rows = await tx.query<QueryResultRow & { page_id: string; title: string | null; body: string }>({
        name: "page_search_heads_v2",
        text: `SELECT p.page_id, data.page_name(r.body) AS title, r.body
          FROM data.pages p
          JOIN data.page_revisions r
            ON r.space_id=p.space_id AND r.page_id=p.page_id AND r.revision=p.head_revision
          WHERE p.space_id=$1 AND p.page_id = ANY($2::text[]) AND strpos(lower(r.body), lower($3)) > 0
          ORDER BY p.updated_at DESC
          LIMIT ${PAGE_SEARCH_RESULT_LIMIT}`,
        values: [spaceId, tree.map((row) => row.page_id), query],
        maxRows: PAGE_SEARCH_RESULT_LIMIT,
      });
      return { results: rows.map((row) => pageSearchHit(row.title ?? UNNAMED_PAGE, row.body ?? "", row.page_id, query)) };
    });
  }

  /** Whether a principal may read a page and edit it, and its head, without its text: what a live ticket needs. */
  async access(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal }):
    Promise<{ canEdit: boolean; agentSuggestOnly: boolean; headRevision: number }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.access", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const row = await this.page(tx, spaceId, actor, pageId, "read");
      return { canEdit: row.canEdit, agentSuggestOnly: row.agent_suggest_only, headRevision: Number(row.head_revision) };
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
    parentPageId?: string | null; title?: string; body?: string; afterPageId?: string | null;
    accessMode?: "open" | "restricted" }): Promise<{ page: PageSummary }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    // The name is written into the document, unless the document already opens with one of its own.
    // Without a name the document is as written: a page someone started writing names itself in its text.
    const newBody = pageBody(input.title === undefined ? input.body ?? "" : namedPageBody(input.body ?? "", input.title));
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
        name: "page_create_v2",
        text: `INSERT INTO data.pages (space_id,page_id,parent_page_id,position,access_mode,
            head_revision,agent_suggest_only,version,created_by_user_id,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,1,FALSE,1,$6,$7,$7)`,
        values: [spaceId, pageId, parentPageId, position, accessMode, actor.userId, now],
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
      await this.chargeRevision(tx, spaceId, actor, now);
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
    await this.chargeRevision(tx, spaceId, actor, now);
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

  /**
   * Starts co-writing a page from a conversation linked to it (pages-live-document.md §4.2): until it
   * ends or lapses, an Agent's edits to the page from that conversation are suggestions. A person who
   * may edit the page starts it; the suggestions wait on them.
   */
  async startCoWriting(input: CoWritingInput): Promise<{ startedAt: string }> {
    return this.coWriting(input, "page.co_writing_start", async (tx, { spaceId, pageId, conversationId, actor }) => {
      const linked = await tx.query({ name: "page_co_writing_linked_v1",
        text: "SELECT 1 FROM data.page_links WHERE space_id=$1 AND page_id=$2 AND conversation_id=$3 LIMIT 1",
        values: [spaceId, pageId, conversationId], maxRows: 1 });
      if (!linked.length) throw new PageControlError("page_link_not_found", 404, "Link the conversation to the page first");
      const started = (await tx.query<QueryResultRow & { started_at: Date | string }>({ name: "page_co_writing_start_v1",
        text: `INSERT INTO data.page_co_writing (space_id,page_id,conversation_id,started_by_user_id,started_at)
          VALUES ($1,$2,$3,$4,now())
          ON CONFLICT (space_id,page_id,conversation_id) DO UPDATE
            SET started_by_user_id=EXCLUDED.started_by_user_id, started_at=EXCLUDED.started_at, ended_at=NULL
          RETURNING started_at`,
        values: [spaceId, pageId, conversationId, actor.userId], maxRows: 1 }))[0]!;
      return { startedAt: new Date(started.started_at).toISOString() };
    });
  }

  /** Ends co-writing from a conversation: its Agent's later edits to the page are edits again. */
  async endCoWriting(input: CoWritingInput): Promise<{ ended: boolean }> {
    return this.coWriting(input, "page.co_writing_end", async (tx, { spaceId, pageId, conversationId }) => {
      const ended = await tx.query({ name: "page_co_writing_end_v1",
        text: `UPDATE data.page_co_writing SET ended_at=now()
          WHERE space_id=$1 AND page_id=$2 AND conversation_id=$3 AND ended_at IS NULL RETURNING 1`,
        values: [spaceId, pageId, conversationId], maxRows: 1 });
      return { ended: ended.length === 1 };
    });
  }

  /**
   * Ends every live co-writing on a page once the people have left it (pages-live-document.md §4.2): its
   * Agents are on the page like colleagues until stopped or the people leave. The page's live session
   * decides it, for nobody in particular; each ended conversation is returned with who started it, whose
   * authority tells its Agent to leave.
   */
  async endCoWritingOnPage(input: { requestId: string; spaceId: string; pageId: string }):
    Promise<Array<{ conversationId: string; startedByUserId: string }>> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.co_writing_end_on_page", spaceId, async (tx) => {
      const ended = await tx.query<QueryResultRow & { conversation_id: string; started_by_user_id: string }>({
        name: "page_co_writing_end_on_page_v1",
        text: `UPDATE data.page_co_writing SET ended_at=now()
          WHERE space_id=$1 AND page_id=$2 AND ended_at IS NULL RETURNING conversation_id,started_by_user_id`,
        values: [spaceId, pageId], maxRows: MAX_LINKS });
      return ended.map((row) => ({ conversationId: row.conversation_id, startedByUserId: row.started_by_user_id }));
    });
  }

  /** Co-writing is a person's to start and end, on a page they may edit. */
  private coWriting<T>(input: CoWritingInput, operation: string, run: (tx: DatabaseTransaction,
    at: { spaceId: string; pageId: string; conversationId: string; actor: Actor }) => Promise<T>): Promise<T> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const conversationId = bounded(input.conversationId, "conversationId");
    if (input.principal.kind !== "user") throw new PageControlError("page_co_writing_human_only", 403);
    return this.inSpace(bounded(input.requestId, "requestId"), operation, spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      await this.page(tx, spaceId, actor, pageId, "edit");
      return run(tx, { spaceId, pageId, conversationId, actor });
    });
  }

  /**
   * The suggestions waiting on a page, oldest first: those after the last one a person reviewed, from
   * the last two weeks. Each is a whole document, based on the revision it names.
   */
  async suggestions(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal }):
    Promise<{ suggestions: PageRevision[] }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.suggestions", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      await this.page(tx, spaceId, actor, pageId, "read");
      const rows = await tx.query<RevisionRow>({
        name: "page_suggestions_waiting_v1",
        text: `SELECT r.revision,r.kind,r.authors_json,r.conversation_ids,r.based_on_revision,r.created_at
          FROM data.page_revisions r JOIN data.pages p ON p.space_id=r.space_id AND p.page_id=r.page_id
          WHERE r.space_id=$1 AND r.page_id=$2 AND r.kind='suggestion'
            AND r.revision > COALESCE(p.suggestions_reviewed_through, 0)
            AND r.created_at > now() - interval '${SUGGESTION_WAIT_DAYS} days'
          ORDER BY r.revision LIMIT ${MAX_WAITING_SUGGESTIONS}`,
        values: [spaceId, pageId], maxRows: MAX_WAITING_SUGGESTIONS,
      });
      return { suggestions: rows.map(revisionOf) };
    });
  }

  /** A person has taken or left every suggestion up to `through`: they stop waiting on the page. */
  async reviewSuggestions(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    through: number }): Promise<{ reviewedThrough: number }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    if (input.principal.kind !== "user") throw new PageControlError("page_suggestion_review_human_only", 403);
    if (!Number.isSafeInteger(input.through) || input.through < 1) {
      throw new PageControlError("invalid_request", 400, "through is invalid");
    }
    return this.inSpace(bounded(input.requestId, "requestId"), "page.suggestions_review", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      await this.page(tx, spaceId, actor, pageId, "edit");
      const stored = (await tx.query<QueryResultRow & { through: string }>({ name: "page_suggestions_review_v1",
        text: `UPDATE data.pages SET suggestions_reviewed_through=GREATEST(COALESCE(suggestions_reviewed_through, 0),
            LEAST($3::bigint, (SELECT MAX(revision) FROM data.page_revisions WHERE space_id=$1 AND page_id=$2)))
          WHERE space_id=$1 AND page_id=$2 RETURNING suggestions_reviewed_through::text AS through`,
        values: [spaceId, pageId, input.through], maxRows: 1 }))[0]!;
      return { reviewedThrough: Number(stored.through) };
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
    Promise<{ headRevision: number; order: string[]; updates: Map<string, PageBlockAwareness["updated"]> }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const requestId = bounded(input.requestId, "requestId");
    const { rows, headRevision } = await this.inSpace(requestId, "page.block-updates", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const row = await this.page(tx, spaceId, actor, pageId, "read");
      const headRevision = Number(row.head_revision);
      // Newest first, with what each revision changed once that is derived (page-section-changes.ts); the
      // newest revision's body gives the page's sections and their order.
      const rows = await tx.query<RevisionRow & SectionRevisionRow & { newest_body: string | null }>({
        name: "page_block_updates_v2",
        text: `SELECT revision,kind,authors_json,conversation_ids,based_on_revision,created_at,changed_blocks,
            CASE WHEN row_number() OVER (ORDER BY revision DESC) = 1 THEN body END AS newest_body
          FROM data.page_revisions WHERE space_id=$1 AND page_id=$2 AND revision <= $3
            AND kind NOT IN ('suggestion','purge')
          ORDER BY revision DESC LIMIT ${BLOCK_UPDATE_REVISIONS}`,
        values: [spaceId, pageId, headRevision], maxRows: BLOCK_UPDATE_REVISIONS,
      });
      return { headRevision, rows };
    });
    // Document parsing must not hold a checkout or exhaust the transaction
    // (XMATRIX-HUB-82); bodies a derivation still needs are read in a
    // transaction of their own.
    const order = pageBlocks(rows[0]?.newest_body ?? "").map((block) => block.id);
    const { updates: changedBy, derived, bodies } = await walkSectionChanges(rows, order, (revisions) =>
      this.inSpace(requestId, "page.block-updates.bodies", spaceId, (tx) =>
        readRevisionBodies(tx, spaceId, pageId, revisions)));
    // What this read derived is kept for the next one; a reader is answered whether or not it could be.
    if (derived.length > 0) {
      await this.inSpace(requestId, "page.block-updates.keep", spaceId, (tx) =>
        keepSectionChanges(tx, spaceId, pageId, derived, bodies)).catch(() => undefined);
    }
    const updates = new Map<string, PageBlockAwareness["updated"]>();
    for (const [blockId, row] of changedBy) {
      const { revision, authors, conversationIds, createdAt } = revisionOf(row);
      updates.set(blockId, { revision, authors, conversationIds, createdAt });
    }
    return { headRevision, order, updates };
  }

  /**
   * Who wrote each piece of the head (page-blame.ts): derived along the page's line from its newest revision
   * already derived, and kept for the next read.
   */
  async blame(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal }):
    Promise<PageBlame> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const requestId = bounded(input.requestId, "requestId");
    const { rows, userId } = await this.inSpace(requestId, "page.blame", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const row = await this.page(tx, spaceId, actor, pageId, "read");
      // The page's line, from its newest revision whose blame is kept, or from its first.
      const rows = await tx.query<BlameRevisionRow>({
        name: "page_blame_line_v1",
        text: `WITH line AS (SELECT revision, blame FROM data.page_revisions
            WHERE space_id=$1 AND page_id=$2 AND revision <= $3 AND kind NOT IN ('suggestion','purge'))
          SELECT revision, blame FROM line
          WHERE revision >= COALESCE((SELECT max(revision) FROM line WHERE blame IS NOT NULL), 0)
          ORDER BY revision`,
        values: [spaceId, pageId, Number(row.head_revision)], maxRows: MAX_GIT_REVISIONS,
      });
      return { rows, userId: actor.userId };
    });
    const head = await walkBlame(rows, (revisions) =>
      this.inSpace(requestId, "page.blame.bodies", spaceId, (tx) => readRevisionBodies(tx, spaceId, pageId, revisions)),
      (derived) => this.inSpace(requestId, "page.blame.keep", spaceId, (tx) => keepBlames(tx, spaceId, pageId, derived)));
    if (!head) throw new PageControlError("page_not_found", 404);
    const named = new Set<number>();
    for (let index = 1; index < head.runs.length; index += 2) named.add(head.runs[index]!);
    const { revisions, conversations } = named.size === 0 ? { revisions: [], conversations: [] }
      : await this.inSpace(requestId, "page.blame.revisions", spaceId, async (tx) => {
        const revisions = (await tx.query<RevisionRow>({
          name: "page_blame_revisions_v1",
          text: `SELECT revision,kind,authors_json,conversation_ids,based_on_revision,created_at
            FROM data.page_revisions WHERE space_id=$1 AND page_id=$2 AND revision = ANY($3::bigint[])`,
          values: [spaceId, pageId, [...named].map(String)], maxRows: named.size,
        })).map(revisionOf);
        // The newest revisions' conversations first, when there are more than are described.
        const ids = [...new Set([...revisions].sort((a, b) => b.revision - a.revision)
          .flatMap((revision) => revision.conversationIds))].slice(0, MAX_BLAME_CONVERSATIONS);
        const conversations = ids.length === 0 ? [] : (await tx.query<QueryResultRow & { channel_id: string; name: string | null }>({
          name: "page_blame_conversations_v1",
          text: `SELECT c.channel_id, c.name FROM data.channels c
            WHERE c.space_id=$1 AND c.channel_id = ANY($2::text[])
              AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
                principalKindSql: "'user'", principalIdSql: "$3" })}`,
          values: [spaceId, ids, userId], maxRows: ids.length,
        })).map((row) => ({ conversationId: row.channel_id, name: row.name ?? "" }));
        return { revisions, conversations };
      });
    return { pageId, revision: head.revision, body: head.body, runs: head.runs, revisions, conversations };
  }

  /**
   * The message `conversationId` was at when `revision` of the page was written: its newest message sent by
   * then. Null unless the revision came from that conversation and the reader can read it.
   */
  async revisionMoment(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    revision: number; conversationId: string }): Promise<PageRevisionMoment | null> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const conversationId = bounded(input.conversationId, "conversationId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.revision-moment", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      await this.page(tx, spaceId, actor, pageId, "read");
      const rows = await tx.query<QueryResultRow & { message_id: string; timeline_sequence: string | number }>({
        name: "page_revision_moment_v1",
        text: `SELECT m.message_id, m.timeline_sequence
          FROM data.page_revisions r
          JOIN data.channels c ON c.space_id=r.space_id AND c.channel_id=$4
          CROSS JOIN LATERAL (SELECT message_id, timeline_sequence FROM data.messages m
            WHERE m.space_id=c.space_id AND m.channel_id=c.channel_id AND m.deleted_at IS NULL AND m.sent_at <= r.created_at
            ORDER BY m.timeline_sequence DESC LIMIT 1) m
          WHERE r.space_id=$1 AND r.page_id=$2 AND r.revision=$3 AND $4 = ANY(r.conversation_ids)
            AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
              principalKindSql: "'user'", principalIdSql: "$5" })}`,
        values: [spaceId, pageId, input.revision, conversationId, actor.userId], maxRows: 1,
      });
      const row = rows[0];
      return row ? { conversationId, messageId: row.message_id, sequence: Number(row.timeline_sequence) } : null;
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
        // Edits are stored in the form the editor saves, so revisions compare
        // as text; only a first revision (a created or migrated page's body as
        // written) is put in that form. Parsing every page here is seconds of
        // CPU inside the transaction, which timed out its COMMIT (XMATRIX-HUB-7T).
        const after = head.body ?? "";
        const { revision, authors, createdAt } = revisionOf(head);
        const created = !before && revision === 1;
        const older = before && (Number(before.revision) === 1 ? canonicalPageMarkdown(before.body ?? "") : before.body ?? "");
        const { blockId, gist } = older !== undefined ? pageChangeGist(older, after) : { blockId: null, gist: null };
        const block = blockId ? pageBlocks(after).find((item) => item.id === blockId) : undefined;
        changes.push({ pageId: page.page_id, title: page.title ?? UNNAMED_PAGE, revision, createdAt, authors, created,
          block: block ? { id: block.id, title: block.title } : null, gist });
      }
      changes.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return { changes: changes.slice(0, limit) };
    });
  }

  async update(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    parentPageId?: string | null; afterPageId?: string | null;
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
        name: "page_update_v2",
        text: `UPDATE data.pages SET parent_page_id=$3, position=$4, access_mode=$5,
            agent_suggest_only=$6, version=version+1, updated_at=$7
          WHERE space_id=$1 AND page_id=$2`,
        values: [spaceId, pageId, parent, position, accessMode, input.agentSuggestOnly ?? row.agent_suggest_only, now],
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
   * Writes a page's summary for the revision its writer read. A summary of a
   * revision the page has moved on from is refused, so the page never carries
   * a line about text it no longer has; whoever may edit the page may write it.
   */
  async setSummary(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    baseRevision: number; summary: string }): Promise<{ summary: NonNullable<PageSummary["summary"]> }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const text = typeof input.summary === "string" ? input.summary.replace(/\s+/gu, " ").trim() : "";
    if (!text || [...text].length > 240) {
      throw new PageControlError("invalid_request", 400, "summary must be 1 to 240 characters");
    }
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1) {
      throw new PageControlError("invalid_request", 400, "baseRevision is invalid");
    }
    return this.inSpace(bounded(input.requestId, "requestId"), "page.summary.set", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, true);
      await this.page(tx, spaceId, actor, pageId, "edit");
      const row = (await tx.query<QueryResultRow & { summary_at: Date | string }>({ name: "page_summary_set_v1",
        text: `UPDATE data.pages SET summary=$3, summary_revision=$4, summary_at=now()
          WHERE space_id=$1 AND page_id=$2 AND head_revision=$4 RETURNING summary_at`,
        values: [spaceId, pageId, text, input.baseRevision], maxRows: 1 }))[0];
      if (!row) throw new PageControlError("page_summary_stale", 409, "the page has changed since that revision");
      return { summary: { text, revision: input.baseRevision, at: iso(row.summary_at) } };
    });
  }

  /** Writes the line a summary execution answered, if the page is still at the revision it read. */
  async recordSummary(input: { requestId: string; spaceId: string; pageId: string; revision: number; summary: string }):
    Promise<{ recorded: boolean }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    const text = typeof input.summary === "string" ? input.summary.replace(/\s+/gu, " ").trim() : "";
    if (!text || [...text].length > 240 || !Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new PageControlError("invalid_request", 400, "summary is invalid");
    }
    return this.inSpace(bounded(input.requestId, "requestId"), "page.summary.record", spaceId, async (tx) => {
      const rows = await tx.query({ name: "page_summary_record_v1",
        text: `UPDATE data.pages SET summary=$3, summary_revision=$4, summary_at=now()
          WHERE space_id=$1 AND page_id=$2 AND head_revision=$4 RETURNING page_id`,
        values: [spaceId, pageId, text, input.revision], maxRows: 1 });
      return { recorded: rows.length > 0 };
    });
  }

  /**
   * The newest revision of a page this person has had on screen whole, or null
   * before they first read it, and the page as they have seen it when they saw
   * part of it past that revision (`seen`; null when it is that revision's
   * text). It is a person's own: an Agent Run has none.
   */
  async readState(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal }):
    Promise<{ revision: number | null; seen: string | null }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    if (input.principal.kind !== "user") throw new PageControlError("page_read_state_human_only", 403);
    return this.inSpace(bounded(input.requestId, "requestId"), "page.read_state", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      await this.page(tx, spaceId, actor, pageId, "read");
      const row = (await tx.query<QueryResultRow & { revision: string; seen_body: string | null }>({
        name: "page_read_state_v2",
        text: "SELECT revision::text, seen_body FROM data.page_reads WHERE space_id=$1 AND page_id=$2 AND user_id=$3",
        values: [spaceId, pageId, actor.userId], maxRows: 1 }))[0];
      return { revision: row ? Number(row.revision) : null, seen: row?.seen_body ?? null };
    });
  }

  /**
   * Moves how far this person has read a page forward to a revision the page has; it never moves back.
   * `seen` is the page as they have seen it past that revision, or null once they have seen it whole; it
   * stands unless an older revision is reported.
   */
  async markRead(input: { requestId: string; spaceId: string; pageId: string; principal: PagePrincipal;
    revision: number; seen?: string | null }): Promise<{ revision: number }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    if (input.principal.kind !== "user") throw new PageControlError("page_read_state_human_only", 403);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new PageControlError("invalid_request", 400, "revision is invalid");
    }
    const seen = input.seen === undefined || input.seen === null ? null : pageBody(input.seen);
    return this.inSpace(bounded(input.requestId, "requestId"), "page.mark_read", spaceId, async (tx) => {
      const actor = await pageActor(tx, spaceId, input.principal, false);
      const row = await this.page(tx, spaceId, actor, pageId, "read");
      const revision = Math.min(input.revision, Number(row.head_revision));
      const stored = (await tx.query<QueryResultRow & { revision: string }>({ name: "page_mark_read_v2",
        text: `INSERT INTO data.page_reads (space_id,page_id,user_id,revision,seen_body,updated_at)
          VALUES ($1,$2,$3,$4,$5,now())
          ON CONFLICT (space_id,page_id,user_id) DO UPDATE
            SET revision=GREATEST(data.page_reads.revision, EXCLUDED.revision),
              seen_body=CASE WHEN EXCLUDED.revision >= data.page_reads.revision THEN EXCLUDED.seen_body
                ELSE data.page_reads.seen_body END,
              updated_at=CASE WHEN EXCLUDED.revision > data.page_reads.revision
                OR (EXCLUDED.revision = data.page_reads.revision
                  AND EXCLUDED.seen_body IS DISTINCT FROM data.page_reads.seen_body)
                THEN EXCLUDED.updated_at ELSE data.page_reads.updated_at END
          RETURNING revision::text`,
        values: [spaceId, pageId, actor.userId, revision, seen], maxRows: 1 }))[0]!;
      return { revision: Number(stored.revision) };
    });
  }

  /**
   * The page a pull request names, for its pre-review: its title (null when
   * the page is gone), whether it is closed to some members, and the Space
   * owner, whose GitHub connection publishes the review. Null when the Space is gone.
   */
  async pullRequestPage(input: { requestId: string; spaceId: string; pageId: string }):
    Promise<{ spaceOwnerUserId: string; pageTitle: string | null; restricted: boolean } | null> {
    const spaceId = bounded(input.spaceId, "spaceId");
    const pageId = bounded(input.pageId, "pageId");
    return this.inSpace(bounded(input.requestId, "requestId"), "page.pull_request", spaceId, async (tx) => {
      const space = await tx.query<QueryResultRow & { owner_user_id: string }>({
        name: "page_pull_request_space_v1", text: "SELECT owner_user_id FROM data.spaces WHERE space_id=$1",
        values: [spaceId], maxRows: 1 });
      if (!space[0]) return null;
      const pages = await tx.query<QueryResultRow & Pick<PageRow, "page_id" | "parent_page_id" | "access_mode" | "title">>({
        name: "page_pull_request_tree_v1",
        text: `SELECT p.page_id,p.parent_page_id,p.access_mode,data.page_name(r.body) AS title
          FROM data.pages p ${HEAD_REVISION} WHERE p.space_id=$1
          ORDER BY p.page_id LIMIT ${MAX_PAGES + 1}`, values: [spaceId], maxRows: MAX_PAGES + 1 });
      const page = pages.find((row) => row.page_id === pageId);
      return { spaceOwnerUserId: space[0].owner_user_id, pageTitle: page ? page.title ?? UNNAMED_PAGE : null,
        restricted: !openToEveryMember(pages, pageId) };
    });
  }

  /**
   * The pages a reader may read and their revisions, for the reader's git
   * view (docs/design/pages-and-conversations.md §5.4). A page the reader
   * cannot read contributes nothing, not even history.
   */
  async gitView(input: { requestId: string; spaceId: string; principal: PagePrincipal }): Promise<{
    spaceName: string;
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
      const space = await tx.query<QueryResultRow & { name: string }>({
        name: "page_git_space_v1", text: "SELECT name FROM data.spaces WHERE space_id=$1", values: [spaceId], maxRows: 1,
      });
      if (!space[0]) throw new PageControlError("space_not_found", 404);
      return {
        spaceName: space[0].name,
        pages: readable.map((row) => ({ pageId: row.page_id, parentPageId: row.parent_page_id,
          title: row.title ?? UNNAMED_PAGE, position: row.position })),
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
        name: "page_public_tree_v2",
        text: `SELECT p.page_id,p.parent_page_id,data.page_name(r.body) AS title,p.position,p.access_mode,
            p.head_revision,p.agent_suggest_only,p.updated_at,p.version,p.published_at
          FROM data.pages p ${HEAD_REVISION}
          WHERE p.space_id=$1 ORDER BY p.position, p.page_id LIMIT ${MAX_PAGES + 1}`,
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
        spaceId, spaceName: space[0]?.name ?? "", pageId, title: row.title ?? UNNAMED_PAGE, body: revision.body ?? "",
        headRevision: Number(row.head_revision), updatedAt: iso(row.updated_at),
        authors: revisionOf(revision).authors.map((author) => ({ kind: author.kind, label: author.label })),
        children: rows.filter((child) => child.parent_page_id === pageId && isPublic(child))
          .map((child) => ({ pageId: child.page_id, title: child.title ?? UNNAMED_PAGE })),
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
      for (const table of ["data.page_links", "data.page_access", "data.page_reads", "data.page_co_writing",
        "data.page_revisions"]) {
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
      // What the page's revisions changed, and who wrote what, were derived from bodies this may have
      // rewritten, and can name the removed text's headings or measure it: they are derived again from the
      // redacted bodies (page-section-changes.ts, page-blame.ts).
      await tx.query({
        name: "page_purge_forget_derivations_v1",
        text: `UPDATE data.page_revisions SET changed_blocks=NULL, blame=NULL
          WHERE space_id=$1 AND page_id=$2 AND (changed_blocks IS NOT NULL OR blame IS NOT NULL)`,
        values: [spaceId, pageId], maxRows: 0,
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
  /**
   * `describe` reads more about the links in the same request session, as the reader it found: a page's
   * margin reads its conversations with them (`describePageConversations`).
   */
  async links<Described = never>(input: { requestId: string; spaceId: string; principal: PagePrincipal;
    pageId?: string; conversationId?: string;
    describe?: (tx: DatabaseTransaction, userId: string, links: PageLink[]) => Promise<Described> }):
    Promise<{ links: PageLink[]; described?: Described }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    if (!input.pageId === !input.conversationId) {
      throw new PageControlError("invalid_request", 400, "name exactly one of pageId or conversationId");
    }
    return this.readInSpace(bounded(input.requestId, "requestId"), "page.links", spaceId, async (tx) => {
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
      return input.describe ? { links: out, described: await input.describe(tx, actor.userId, out) } : { links: out };
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
  async agentsOnPages<Described = never>(input: { requestId: string; spaceId: string; principal: PagePrincipal;
    /** Reads more about the open discussions, newest first, in the same read session (as `links` does). */
    describe?: (tx: DatabaseTransaction, userId: string, discussions: string[]) => Promise<Described> }):
    Promise<{ pages: Array<{ pageId: string; agents: PageTreeAgent[]; discussions: string[] }>; described?: Described }> {
    const spaceId = bounded(input.spaceId, "spaceId");
    return this.readInSpace(bounded(input.requestId, "requestId"), "page.agents", spaceId, async (tx) => {
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
              ...(member.registration?.harness ? { harness: member.registration.harness } : {}),
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
          // Readers see the canonical form, and stored heads almost always are;
          // a whole page is put in that form only when a section is missing.
          const sections = (body: string) => new Map(pageBlocks(body).map((block) => [block.id, block.title]));
          const agents = byPage.get(head.page_id) ?? [];
          let titles = sections(head.body ?? "");
          if (agents.some((agent) => agent.blockId && !titles.has(agent.blockId))) {
            titles = sections(canonicalPageMarkdown(head.body ?? ""));
          }
          for (const agent of agents) {
            const section = agent.blockId ? titles.get(agent.blockId) : undefined;
            if (section) agent.section = section;
          }
        }
      }
      const pageIds = new Set([...byPage.keys(), ...discussionsOf.keys()]);
      const pages = [...pageIds].map((pageId) => ({ pageId, agents: byPage.get(pageId) ?? [],
        discussions: discussionsOf.get(pageId) ?? [] }));
      return input.describe ? { pages, described: await input.describe(tx, actor.userId,
        [...new Set(pages.flatMap((page) => page.discussions))]) } : { pages };
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
