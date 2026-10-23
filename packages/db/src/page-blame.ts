import type { QueryResultRow } from "pg";
import { sha256Hex } from "@xmatrix/protocol";
import { pageBlameFirst, pageBlameStep } from "@xmatrix/protocol/page-document";
import type { DatabaseTransaction } from "./contracts.js";

/**
 * Who wrote each piece of a page (protocol page-blame.ts). A revision's blame is derived from the blame and body
 * of the revision before it in the page's line, and from its own body, once, and kept on the revision
 * (`page_revisions.blame`, migration 0211), so reading the head's blame compares only the revisions not derived
 * yet. The bodies stay the source: a purge, which rewrites them, forgets every blame on the page.
 */

/** A revision of the page's line, oldest first: its blame once derived, NULL until then. */
export type BlameRevisionRow = QueryResultRow & { revision: string | number; blame: number[] | null };

/** Bodies read at once while deriving; each batch's blame is kept before the next is read. */
const BLAME_BATCH = 24;

/** A run of derived revisions, and the derived revision it was derived from (null from the page's first revision). */
export interface DerivedBlames {
  base: { revision: number; runs: number[] } | null;
  blames: Array<{ revision: number; runs: number[] }>;
  bodies: ReadonlyMap<number, string>;
}

/**
 * The newest revision's blame and body, from `rows`: the page's line from its newest derived revision (or its
 * first) to the newest. What is derived on the way is handed to `keep` batch by batch, so a long page derived
 * for the first time keeps its progress; the reader is answered whether or not it could be kept.
 */
export async function walkBlame(rows: readonly BlameRevisionRow[],
  readBodies: (revisions: number[]) => Promise<Map<number, string>>,
  keep: (derived: DerivedBlames) => Promise<unknown>): Promise<{ revision: number; body: string; runs: number[] } | null> {
  if (rows.length === 0) return null;
  const first = rows[0]!;
  let previous: { revision: number; body: string | null; runs: number[] | null } = {
    revision: Number(first.revision), body: null, runs: first.blame,
  };
  let index = 1;
  if (previous.runs === null) index = 0;
  while (true) {
    const batch = rows.slice(index, index + BLAME_BATCH);
    const wanted = batch.map((row) => Number(row.revision));
    if (previous.body === null) wanted.push(previous.revision);
    const bodies = await readBodies([...new Set(wanted)]);
    let before = previous.body ?? bodies.get(previous.revision) ?? "";
    previous.body = before;
    const base = previous.runs === null ? null : { revision: previous.revision, runs: previous.runs };
    const blames: DerivedBlames["blames"] = [];
    for (const row of batch) {
      const revision = Number(row.revision);
      const body = bodies.get(revision) ?? "";
      const runs = previous.runs === null ? pageBlameFirst(body, revision)
        : pageBlameStep(before, previous.runs, body, revision);
      before = body;
      blames.push({ revision, runs });
      previous = { revision, body, runs };
      // Other requests sharing the isolate run between revisions.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (blames.length) await keep({ base, blames, bodies }).catch(() => undefined);
    index += batch.length;
    if (index >= rows.length) return { revision: previous.revision, body: before, runs: previous.runs ?? [] };
  }
}

/**
 * Keeps a batch of derived blames. The base and every revision derived are share-locked, without waiting, and
 * kept only while each body is still the one compared and the base's kept blame is still the one derived from:
 * a purge that rewrote a body or forgot the page's blame first wins, and one that comes after waits for this
 * and then forgets it. Two readers deriving the same revision keep it once.
 */
export async function keepBlames(tx: DatabaseTransaction, spaceId: string, pageId: string,
  derived: DerivedBlames): Promise<number> {
  const revisions = [...new Set([...(derived.base ? [derived.base.revision] : []),
    ...derived.blames.map((item) => item.revision)])];
  const compared = new Map(await Promise.all(revisions.map(async (revision) =>
    [revision, await sha256Hex(derived.bodies.get(revision) ?? "")] as const)));
  const current = new Map((await tx.query<QueryResultRow & { revision: string | number; hash: string;
    blame: number[] | null }>({
    name: "page_revision_blame_lock_v1",
    text: `SELECT revision, encode(sha256(convert_to(body, 'UTF8')), 'hex') AS hash, blame
      FROM data.page_revisions WHERE space_id=$1 AND page_id=$2 AND revision = ANY($3::bigint[])
      ORDER BY revision FOR SHARE NOWAIT`,
    values: [spaceId, pageId, revisions.map(String)], maxRows: revisions.length,
  })).map((row) => [Number(row.revision), row]));
  if (revisions.some((revision) => current.get(revision)?.hash !== compared.get(revision))) return 0;
  if (derived.base && !sameRuns(current.get(derived.base.revision)?.blame ?? null, derived.base.runs)) return 0;
  await tx.query({
    name: "page_revision_blame_keep_v1",
    text: `UPDATE data.page_revisions r SET blame = ARRAY(SELECT jsonb_array_elements_text(d.runs::jsonb)::int)
      FROM unnest($3::bigint[], $4::text[]) AS d(revision, runs)
      WHERE r.space_id=$1 AND r.page_id=$2 AND r.revision=d.revision AND r.blame IS NULL`,
    values: [spaceId, pageId, derived.blames.map((item) => String(item.revision)),
      derived.blames.map((item) => JSON.stringify(item.runs))],
    maxRows: 0,
  });
  return derived.blames.length;
}

function sameRuns(kept: readonly number[] | null, runs: readonly number[]): boolean {
  return kept !== null && kept.length === runs.length && kept.every((value, index) => Number(value) === runs[index]);
}
