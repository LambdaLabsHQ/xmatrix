import type { QueryResultRow } from "pg";
import { sha256Hex } from "@xmatrix/protocol";
import { canonicalPageMarkdown, pageChangedDocBlocksAsync } from "@xmatrix/protocol/page-document";
import type { DatabaseTransaction } from "./contracts.js";

/**
 * When each section of a page last changed (pages-live-document.md §3.2): walked from the newest revision
 * back, a section's first change is its last. What a revision changed against the revision before it is
 * derived from the two bodies once and kept on the revision (`changed_blocks`, migration 0210), so reading a
 * page's awareness compares no documents once its recent revisions are derived. The bodies stay the source:
 * a purge, which rewrites them, forgets every derivation on the page.
 */

/** A revision as the walk reads it, newest first: what it changed once derived, NULL until then. */
export type SectionRevisionRow = QueryResultRow & { revision: string | number; changed_blocks: string[] | null };

/** A revision's changed sections, derived on this read and not yet kept. */
export interface DerivedSectionChange { revision: number; previous: number; changed: string[] }

/** At most this many sections are kept for one revision; one that changed more is derived again when read. */
const MAX_KEPT_SECTIONS = 2_000;

/**
 * Each of `order`'s sections, with the newest revision in `rows` that changed it. A revision in reach with no
 * revision before it is the page's first only when it is revision 1: it wrote whatever is left; any other
 * reads as unknown. Bodies are read only when a revision's changes are not derived yet, all at once.
 */
export async function walkSectionChanges<Row extends SectionRevisionRow>(rows: readonly Row[],
  order: readonly string[], readBodies: (revisions: number[]) => Promise<Map<number, string>>):
  Promise<{ updates: Map<string, Row>; derived: DerivedSectionChange[]; bodies: Map<number, string> }> {
  const open = new Set(order);
  const updates = new Map<string, Row>();
  const derived: DerivedSectionChange[] = [];
  let bodies: Map<number, string> | null = null;
  // Compared as documents, so a change of markdown style is no change. Only sections whose text differs
  // are put in canonical form, and other requests sharing the isolate run between them (XMATRIX-HUB-68).
  const canonicalSections = new Map<string, string>();
  const canonical = async (section: string) => {
    let form = canonicalSections.get(section);
    if (form === undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      canonicalSections.set(section, form = canonicalPageMarkdown(section));
    }
    return form;
  };
  for (let index = 0; index < rows.length && open.size; index++) {
    const row = rows[index]!;
    const older = rows[index + 1];
    let changed = row.changed_blocks;
    if (changed === null) {
      if (older) {
        bodies ??= await readBodies(underivedFrom(rows, index));
        const newerBody = bodies.get(Number(row.revision));
        const olderBody = bodies.get(Number(older.revision));
        if (newerBody === undefined || olderBody === undefined) changed = [];
        else {
          changed = await pageChangedDocBlocksAsync(olderBody, newerBody, canonical);
          derived.push({ revision: Number(row.revision), previous: Number(older.revision), changed });
        }
      } else changed = Number(row.revision) === 1 ? [...open] : [];
    }
    for (const blockId of changed) if (open.delete(blockId)) updates.set(blockId, row);
  }
  return { updates, derived, bodies: bodies ?? new Map() };
}

/** The bodies the revisions from `index` on compare: each one not derived yet, and the one before it. */
function underivedFrom(rows: readonly SectionRevisionRow[], index: number): number[] {
  const revisions = new Set<number>();
  for (let at = index; at < rows.length - 1; at++) {
    if (rows[at]!.changed_blocks !== null) continue;
    revisions.add(Number(rows[at]!.revision));
    revisions.add(Number(rows[at + 1]!.revision));
  }
  return [...revisions];
}

/** The bodies of `revisions` of one page, in this transaction. */
export async function readRevisionBodies(tx: DatabaseTransaction, spaceId: string, pageId: string,
  revisions: readonly number[]): Promise<Map<number, string>> {
  if (revisions.length === 0) return new Map();
  const rows = await tx.query<QueryResultRow & { revision: string | number; body: string }>({
    name: "page_revision_bodies_v1",
    text: `SELECT revision, body FROM data.page_revisions
      WHERE space_id=$1 AND page_id=$2 AND revision = ANY($3::bigint[])`,
    values: [spaceId, pageId, revisions.map(String)], maxRows: revisions.length,
  });
  return new Map(rows.map((row) => [Number(row.revision), row.body]));
}

/**
 * Keeps what this read derived. Every revision a change was derived from is share-locked, without waiting,
 * and kept only while its body is still the one compared: a purge that rewrote either body first wins, and
 * one that comes after waits for this and then forgets it. Two readers deriving the same revision keep it once.
 */
export async function keepSectionChanges(tx: DatabaseTransaction, spaceId: string, pageId: string,
  derived: readonly DerivedSectionChange[], bodies: ReadonlyMap<number, string>): Promise<number> {
  const candidates = derived.filter((item) => item.changed.length <= MAX_KEPT_SECTIONS);
  if (candidates.length === 0) return 0;
  const revisions = [...new Set(candidates.flatMap((item) => [item.revision, item.previous]))];
  const compared = new Map(await Promise.all(revisions.map(async (revision) =>
    [revision, await sha256Hex(bodies.get(revision) ?? "")] as const)));
  const current = new Map((await tx.query<QueryResultRow & { revision: string | number; hash: string;
    underived: boolean }>({
    name: "page_revision_changes_lock_v1",
    text: `SELECT revision, encode(sha256(convert_to(body, 'UTF8')), 'hex') AS hash,
        changed_blocks IS NULL AS underived
      FROM data.page_revisions WHERE space_id=$1 AND page_id=$2 AND revision = ANY($3::bigint[])
      ORDER BY revision FOR SHARE NOWAIT`,
    values: [spaceId, pageId, revisions.map(String)], maxRows: revisions.length,
  })).map((row) => [Number(row.revision), row]));
  const unchanged = (revision: number) => current.get(revision)?.hash === compared.get(revision);
  const kept = candidates.filter((item) => current.get(item.revision)?.underived === true
    && unchanged(item.revision) && unchanged(item.previous));
  if (kept.length === 0) return 0;
  await tx.query({
    name: "page_revision_changes_keep_v1",
    text: `UPDATE data.page_revisions r SET changed_blocks = ARRAY(SELECT jsonb_array_elements_text(d.changed::jsonb))
      FROM unnest($3::bigint[], $4::text[]) AS d(revision, changed)
      WHERE r.space_id=$1 AND r.page_id=$2 AND r.revision=d.revision AND r.changed_blocks IS NULL`,
    values: [spaceId, pageId, kept.map((item) => String(item.revision)), kept.map((item) => JSON.stringify(item.changed))],
    maxRows: 0,
  });
  return kept.length;
}
