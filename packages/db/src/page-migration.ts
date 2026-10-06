import type { QueryResultRow } from "pg";
import { lowercaseHex , utf8ByteLength } from "@xmatrix/protocol";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { MessageAuthorityError } from "./message-authority-error.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import {
  inActiveSpace, pageActor, pageBody, pagePositionBetween, pageTitle, type PageActor, type PagePrincipal,
} from "./page-control.js";
import type {
  PageAuthor, PageMigration, PageMigrationApplied, PageMigrationDraft,
  PageMigrationDraftPage, PageMigrationReport, PageMigrationSource,
} from "@xmatrix/protocol";

export type { PageMigration, PageMigrationDraft, PageMigrationDraftPage, PageMigrationReport, PageMigrationSource };

/**
 * A Space's move to pages (docs/design/pages-and-conversations-migration.md §3).
 *
 * An Agent reads the Space's conversations and memory and drafts a new page
 * tree: its own structure, concise bodies, and the conversations each page was
 * written from. A Space owner or admin reviews the draft, may drop or rename
 * pages, and applies it. Every step is compare-and-set on the whole draft, and
 * applying it is one transaction: the pages, their first revisions (authored
 * by the drafter) and their source links appear together or not at all.
 *
 * A draft cites only conversations its author can read, and never a direct
 * conversation. A page cited from a closed conversation is restricted to the
 * readers every one of its closed sources has when the draft is applied, so a
 * page never widens who reads what it was written from.
 */

export class PageMigrationError extends MessageAuthorityError {
  constructor(code: string, status: number, message = code) { super(code, status, message); }
}

const MAX_PAGES = 500;
const MAX_SOURCES = 200;
const MAX_DRAFT_BYTES = 8 * 1024 * 1024;
const MAX_READER_GRANTS = 5_000;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/u;

type MigrationRow = QueryResultRow & {
  state: "proposed" | "confirmed" | "applied";
  /** A draft while proposed; once applied, the drafter and each node's page. */
  plan_json: { draft?: PageMigrationDraft; drafter?: PageAuthor; pages?: Array<{ key: string; pageId: string }>;
    applied?: PageMigrationApplied };
  report_json: PageMigrationReport | null;
  version: string | number;
  proposed_at: Date | string;
};

type SourceRow = QueryResultRow & { channel_id: string; name: string; mode: string; readable: boolean };

function invalid(message: string): PageMigrationError {
  return new PageMigrationError("invalid_page_migration_draft", 400, message);
}

/** A draft whose parents precede their children, with unique keys and valid pages. */
export function validDraft(value: unknown): PageMigrationDraft {
  const pages = (value as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES) {
    throw invalid(`A draft has 1-${MAX_PAGES} pages`);
  }
  if (utf8ByteLength(JSON.stringify(pages)) > MAX_DRAFT_BYTES) {
    throw new PageMigrationError("page_migration_draft_too_large", 413, "A draft is at most 8 MiB");
  }
  const keys = new Set<string>();
  const out: PageMigrationDraftPage[] = (pages as Array<Record<string, unknown> | null>).map((page) => {
    const key = page?.key;
    if (typeof key !== "string" || !KEY.test(key) || keys.has(key)) throw invalid("Every page has a unique key");
    const parentKey = page?.parentKey ?? null;
    if (parentKey !== null && (typeof parentKey !== "string" || !keys.has(parentKey))) {
      throw invalid(`Page ${key}: parentKey names an earlier page`);
    }
    const sources = page?.sources ?? [];
    if (!Array.isArray(sources) || sources.length > MAX_SOURCES ||
      sources.some((id) => typeof id !== "string" || !id || id.length > 300)) {
      throw invalid(`Page ${key}: sources are at most ${MAX_SOURCES} conversation ids`);
    }
    keys.add(key);
    return { key, parentKey: parentKey as string | null, title: pageTitle(page?.title), body: pageBody(page?.body),
      sources: [...new Set(sources as string[])] };
  });
  return { pages: out };
}

/** The draft without the dropped pages, whose children move up to the nearest kept ancestor. */
export function revisedDraft(draft: PageMigrationDraft, drop: ReadonlySet<string>,
  titles: Readonly<Record<string, string>>): PageMigrationDraft {
  const parentOf = new Map(draft.pages.map((page) => [page.key, page.parentKey]));
  const keptParent = (key: string | null): string | null => {
    let current = key;
    while (current !== null && drop.has(current)) current = parentOf.get(current) ?? null;
    return current;
  };
  return validDraft({ pages: draft.pages.filter((page) => !drop.has(page.key)).map((page) => ({
    ...page, parentKey: keptParent(page.parentKey), title: titles[page.key] ?? page.title,
  })) });
}

/** A stable UUID-shaped page id for a draft page. */
export async function migratedPageId(spaceId: string, key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`xmatrix-page-migration:${spaceId}:${key}`)));
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = lowercaseHex(digest.slice(0, 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sourceIds(draft: PageMigrationDraft): string[] {
  return [...new Set(draft.pages.flatMap((page) => page.sources))];
}

export class PostgresPageMigrationRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new PageMigrationError("cached_authority_forbidden", 500);
  }

  private run<T>(requestId: string, operation: string, spaceId: string,
    callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return inActiveSpace(this.database, { requestId, operation, spaceId }, PageMigrationError, callback);
  }

  /** Moving a Space to pages is its owners' and admins' act, or that of an Agent Run one of them owns. */
  private async admin(tx: DatabaseTransaction, spaceId: string, principal: PagePrincipal, write: boolean):
    Promise<PageActor> {
    const actor = await pageActor(tx, spaceId, principal, write);
    if (actor.role !== "owner" && actor.role !== "admin") {
      throw new PageMigrationError("page_migration_admin_only", 403, "Only Space owners and admins move a Space to pages");
    }
    return actor;
  }

  /** A draft, or an applied migration; a proposal from before drafts existed is no draft. */
  private async row(tx: DatabaseTransaction, spaceId: string, lock = false): Promise<MigrationRow | null> {
    return (await tx.query<MigrationRow>({
      name: lock ? "page_migration_lock_v2" : "page_migration_read_v2",
      text: `SELECT state,plan_json,report_json,version,proposed_at FROM data.page_migrations
        WHERE space_id=$1 AND (state='applied' OR plan_json ? 'draft')${lock ? " FOR UPDATE" : ""}`,
      values: [spaceId], maxRows: 1,
    }))[0] ?? null;
  }

  /**
   * The cited conversations as the reader sees them now. An Agent reads a
   * conversation only when both it and its owner may.
   */
  private async sources(tx: DatabaseTransaction, spaceId: string, ids: string[], reader: PageActor):
    Promise<SourceRow[]> {
    if (!ids.length) return [];
    const agentReads = reader.isAgent
      ? ` AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
        principalKindSql: "'agent'", principalIdSql: "$4" })}` : "";
    return [...await tx.query<SourceRow>({
      name: reader.isAgent ? "page_migration_sources_agent_v1" : "page_migration_sources_v1",
      text: `SELECT c.channel_id, c.name, c.mode,
          (${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
            principalKindSql: "'user'", principalIdSql: "$3" })}${agentReads}) AS readable
        FROM data.channels c WHERE c.space_id=$1 AND c.channel_id = ANY($2::text[])`,
      values: reader.isAgent ? [spaceId, ids, reader.userId, reader.author.id] : [spaceId, ids, reader.userId],
      maxRows: ids.length,
    })];
  }

  /** Every cited conversation exists and the reader may read it. */
  private async readableSources(tx: DatabaseTransaction, spaceId: string, draft: PageMigrationDraft,
    reader: PageActor): Promise<SourceRow[]> {
    const ids = sourceIds(draft);
    const rows = await this.sources(tx, spaceId, ids, reader);
    const byId = new Map(rows.map((row) => [row.channel_id, row]));
    const refused = ids.filter((id) => !byId.get(id)?.readable);
    if (refused.length) {
      throw new PageMigrationError("page_migration_source_forbidden", 403,
        `A draft cites only conversations its author may read, and no direct conversation: ${refused.slice(0, 5).join(", ")}`);
    }
    return rows;
  }

  private view(spaceId: string, row: MigrationRow | null, sources: SourceRow[]): PageMigration {
    return {
      spaceId,
      state: row === null ? "none" : row.state === "applied" ? "applied" : "proposed",
      version: row === null ? 0 : Number(row.version),
      drafter: row?.plan_json.drafter ?? null,
      draft: row?.plan_json.draft ?? { pages: [] },
      sources: sources.map((source): PageMigrationSource => ({
        conversationId: source.channel_id, name: source.name, closed: source.mode === "closed" })),
      report: row?.report_json ?? null,
      applied: row?.plan_json.applied ?? null,
    };
  }

  async get(input: { requestId: string; spaceId: string; principal: PagePrincipal }): Promise<PageMigration> {
    return this.run(input.requestId, "page.migration.get", input.spaceId, async (tx) => {
      const actor = await this.admin(tx, input.spaceId, input.principal, false);
      const row = await this.row(tx, input.spaceId);
      const draft = row?.plan_json.draft;
      // Reading a draft follows the rule that wrote it: its reader must be able to read every source.
      const sources = draft && row!.state !== "applied"
        ? await this.readableSources(tx, input.spaceId, draft, actor) : [];
      return this.view(input.spaceId, row, sources);
    });
  }

  /** Submits a draft, replacing the one at `version` (0 when there is none). Its author is the caller. */
  async submit(input: { requestId: string; spaceId: string; principal: PagePrincipal; version: number;
    draft: unknown }): Promise<PageMigration> {
    const draft = validDraft(input.draft);
    return this.run(input.requestId, "page.migration.submit", input.spaceId, async (tx) => {
      const actor = await this.admin(tx, input.spaceId, input.principal, true);
      const sources = await this.readableSources(tx, input.spaceId, draft, actor);
      const row = await this.store(tx, input.spaceId, input.version, { draft, drafter: actor.author });
      return this.view(input.spaceId, row, sources);
    });
  }

  /** A reviewer drops or renames pages of the draft at `version`. */
  async revise(input: { requestId: string; spaceId: string; principal: PagePrincipal; version: number;
    drop: string[]; titles: Record<string, string> }): Promise<PageMigration> {
    return this.run(input.requestId, "page.migration.revise", input.spaceId, async (tx) => {
      const actor = await this.admin(tx, input.spaceId, input.principal, true);
      const current = await this.row(tx, input.spaceId, true);
      if (!current?.plan_json.draft || current.state === "applied") throw conflict();
      const draft = revisedDraft(current.plan_json.draft, new Set(input.drop), input.titles);
      const sources = await this.readableSources(tx, input.spaceId, draft, actor);
      const row = await this.store(tx, input.spaceId, input.version,
        { draft, drafter: current.plan_json.drafter! });
      return this.view(input.spaceId, row, sources);
    });
  }

  /**
   * Stores a draft over the one at `version`. Version 0 means there is none,
   * so it only inserts, or replaces a proposal from before drafts existed.
   */
  private async store(tx: DatabaseTransaction, spaceId: string, version: number,
    plan: { draft: PageMigrationDraft; drafter: PageAuthor }): Promise<MigrationRow> {
    const stored = await tx.query<MigrationRow>(version === 0 ? {
      name: "page_migration_store_first_v1",
      text: `INSERT INTO data.page_migrations (space_id,state,plan_json,proposed_at,version)
        VALUES ($1,'proposed',$2::jsonb,now(),1)
        ON CONFLICT (space_id) DO UPDATE SET state='proposed', plan_json=EXCLUDED.plan_json,
          proposed_at=now(), confirmed_by_user_id=NULL, confirmed_at=NULL,
          version=data.page_migrations.version+1
        WHERE data.page_migrations.state<>'applied' AND NOT (data.page_migrations.plan_json ? 'draft')
        RETURNING state,plan_json,report_json,version,proposed_at`,
      values: [spaceId, JSON.stringify(plan)], maxRows: 1,
    } : {
      name: "page_migration_store_v2",
      text: `UPDATE data.page_migrations SET plan_json=$3::jsonb, proposed_at=now(), version=version+1
        WHERE space_id=$1 AND version=$2 AND state='proposed' AND plan_json ? 'draft'
        RETURNING state,plan_json,report_json,version,proposed_at`,
      values: [spaceId, version, JSON.stringify(plan)], maxRows: 1,
    });
    if (stored.length) return stored[0]!;
    if ((await this.row(tx, spaceId))?.state === "applied") {
      throw new PageMigrationError("page_migration_applied", 409, "This Space has already moved to pages");
    }
    throw conflict();
  }

  /**
   * Publishes the draft at `version`, as a Space owner or admin or their Agent.
   * Applying again after it succeeded returns the applied migration unchanged:
   * the pages evolve on their own from then on.
   */
  async apply(input: { requestId: string; spaceId: string; principal: PagePrincipal; version: number }):
    Promise<PageMigration> {
    return this.run(input.requestId, "page.migration.apply", input.spaceId, async (tx) => {
      const actor = await this.admin(tx, input.spaceId, input.principal, true);
      const row = await this.row(tx, input.spaceId, true);
      if (row?.state === "applied") return this.view(input.spaceId, row, []);
      if (!row?.plan_json.draft || Number(row.version) !== input.version) throw conflict();
      const { draft, drafter } = row.plan_json as { draft: PageMigrationDraft; drafter: PageAuthor };
      const sources = await this.readableSources(tx, input.spaceId, draft, actor);
      const report = await this.publish(tx, input.spaceId, actor.userId, draft, drafter, sources);
      // The pages' revisions now own the text; the record keeps who drafted
      // it, who applied it, and which page each draft node became,
      // so no second copy outlives a purge.
      const pages = await Promise.all(draft.pages.map(async (page) =>
        ({ key: page.key, pageId: await migratedPageId(input.spaceId, page.key) })));
      const applied: PageMigrationApplied = { by: actor.author };
      const stored = await tx.query<MigrationRow>({
        name: "page_migration_applied_v3",
        text: `UPDATE data.page_migrations SET state='applied', plan_json=$4::jsonb, confirmed_by_user_id=$2,
            confirmed_at=now(), applied_at=now(), report_json=$3::jsonb, version=version+1
          WHERE space_id=$1 RETURNING state,plan_json,report_json,version,proposed_at`,
        values: [input.spaceId, actor.isAgent ? null : actor.userId, JSON.stringify(report),
          JSON.stringify({ drafter, pages, applied })],
        maxRows: 1,
      });
      return this.view(input.spaceId, stored[0]!, []);
    });
  }

  private async publish(tx: DatabaseTransaction, spaceId: string, userId: string, draft: PageMigrationDraft,
    drafter: PageAuthor, sources: SourceRow[]): Promise<PageMigrationReport> {
    const closed = sources.filter((source) => source.mode === "closed").map((source) => source.channel_id);
    // Readers of each closed source as they are now, not as they were when the draft was written.
    const readers = new Map<string, Set<string>>(closed.map((id) => [id, new Set<string>()]));
    if (closed.length) {
      const grants = await tx.query<QueryResultRow & { channel_id: string; subject_id: string }>({
        name: "page_migration_source_readers_v1",
        text: `SELECT channel_id, subject_id FROM data.channel_access
          WHERE space_id=$1 AND channel_id = ANY($2::text[]) AND subject_kind='user'`,
        values: [spaceId, closed], maxRows: MAX_READER_GRANTS + 1,
      });
      if (grants.length > MAX_READER_GRANTS) throw new PageMigrationError("page_migration_too_large", 409);
      for (const grant of grants) readers.get(grant.channel_id)!.add(grant.subject_id);
    }
    const lastRoot = (await tx.query<QueryResultRow & { position: string }>({
      name: "page_migration_last_root_v1",
      text: `SELECT position FROM data.pages WHERE space_id=$1 AND parent_page_id IS NULL
        ORDER BY position DESC LIMIT 1`,
      values: [spaceId], maxRows: 1,
    }))[0]?.position ?? null;
    const pageIds = new Map<string, string>();
    for (const page of draft.pages) pageIds.set(page.key, await migratedPageId(spaceId, page.key));
    const lastPosition = new Map<string | null, string | null>([[null, lastRoot]]);
    const report: PageMigrationReport = { pages: 0, links: 0, restrictedPages: 0 };
    const now = new Date().toISOString();
    for (const page of draft.pages) {
      const pageId = pageIds.get(page.key)!;
      const parentPageId = page.parentKey === null ? null : pageIds.get(page.parentKey)!;
      const position = pagePositionBetween(lastPosition.get(parentPageId) ?? null, null);
      lastPosition.set(parentPageId, position);
      const closedSources = page.sources.filter((id) => readers.has(id));
      await tx.query({
        name: "page_migration_page_v2",
        text: `INSERT INTO data.pages (space_id,page_id,parent_page_id,title,position,access_mode,head_revision,
            agent_suggest_only,version,created_by_user_id,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,1,FALSE,1,$7,$8,$8)`,
        values: [spaceId, pageId, parentPageId, page.title, position,
          closedSources.length ? "restricted" : "open", userId, now],
        maxRows: 0,
      });
      await tx.query({
        name: "page_migration_revision_v2",
        text: `INSERT INTO data.page_revisions (space_id,page_id,revision,body,authors_json,conversation_ids,
            kind,based_on_revision,created_at)
          VALUES ($1,$2,1,$3,$4::jsonb,$5::text[],'edit',NULL,$6)`,
        values: [spaceId, pageId, page.body, JSON.stringify([drafter]), page.sources, now], maxRows: 0,
      });
      report.pages++;
      if (closedSources.length) {
        report.restrictedPages++;
        const [first, ...rest] = closedSources.map((id) => readers.get(id)!);
        const shared = [...first!].filter((user) => rest.every((set) => set.has(user)));
        if (shared.length) {
          await tx.query({
            name: "page_migration_page_access_v2",
            text: `INSERT INTO data.page_access (space_id,page_id,subject_kind,subject_id,access,created_at)
              SELECT $1,$2,'user',subject_id,'edit',$4 FROM unnest($3::text[]) AS subject_id`,
            values: [spaceId, pageId, shared, now], maxRows: 0,
          });
        }
      }
      for (const conversationId of page.sources) {
        await tx.query({
          name: "page_migration_link_v2",
          text: `INSERT INTO data.page_links (space_id,link_id,conversation_id,page_id,block_id,source,
              created_by_kind,created_by_id,created_at,last_seen_at)
            VALUES ($1,$2,$3,$4,'','migration',$5,$6,$7,$7)`,
          values: [spaceId, `migration:${pageId}:${conversationId}`, conversationId, pageId,
            drafter.kind, drafter.id, now],
          maxRows: 0,
        });
        report.links++;
      }
    }
    return report;
  }
}

function conflict(): PageMigrationError {
  return new PageMigrationError("page_migration_conflict", 409, "The draft changed; read it again");
}
