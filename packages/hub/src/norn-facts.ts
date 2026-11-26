import { PostgresNornProgramRepository, PostgresPageRepository, readHoldingNornPrograms, type PagePrincipal } from "@xmatrix/db";
import { ensureAndWakeNornBranches } from "./norn-branches";
import { checkPageFactBlock, collectSpaceLibraries, nornFactBlocks, nornStep, type NornHoldUpdate, type SpaceLibraryCatalog } from "./norn-host";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { postgresMessageRoute } from "./postgres-message-authority";
import type { Env } from "./types";
import type { Ledger } from "./vendor/norn/runtime/ledger";

const PAGE_HOLD_PREFIX = "page:";

function database(env: Env) {
  return createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-norn-facts",
    statementTimeoutMs: 5_000, transactionTimeoutMs: 15_000, lockTimeoutMs: 2_000,
  });
}

function pageTypeNamesFromKinds(holdKinds: readonly string[]): string[] {
  const names = new Set<string>();
  for (const kind of holdKinds) {
    if (kind.startsWith(PAGE_HOLD_PREFIX)) names.add(kind.slice(PAGE_HOLD_PREFIX.length));
  }
  return [...names];
}

/**
 * Re-validates all `page:<Type>` facts currently held in a program's ledger
 * against `spaceCatalog` before a revision or library adoption evaluates.
 * Conforming blocks are refreshed; blocks that were removed, lost edit access,
 * or no longer check against an updated library type are retracted (`null`) so
 * the revised program never reads stale schema-mismatched records.
 */
export async function revalidatePageFactHolds(
  env: Env,
  input: {
    spaceId: string;
    authorityUserId: string;
    spaceCatalog: SpaceLibraryCatalog;
    existingHolds?: Ledger["holds"];
  },
): Promise<NornHoldUpdate[]> {
  if (!input.existingHolds) return [];
  const heldByType: Array<{ typeName: string; ids: string[] }> = [];
  for (const [kind, entries] of Object.entries(input.existingHolds)) {
    if (!kind.startsWith(PAGE_HOLD_PREFIX)) continue;
    const ids = Object.keys(entries ?? {});
    if (ids.length) heldByType.push({ typeName: kind.slice(PAGE_HOLD_PREFIX.length), ids });
  }
  if (!heldByType.length) return [];
  const db = database(env);
  const principal: PagePrincipal = { kind: "user", id: input.authorityUserId };
  const { pages: factPages } = await new PostgresPageRepository(db).factPages({
    requestId: crypto.randomUUID(), spaceId: input.spaceId, principal,
  });
  const editableById = new Map(factPages.filter(page => page.canEdit).map(page => [page.pageId, page.body]));
  const updates: NornHoldUpdate[] = [];
  for (const { typeName, ids } of heldByType) {
    for (const pageId of ids) {
      const body = editableById.get(pageId);
      const block = body ? nornFactBlocks(body).find(candidate => candidate.typeName === typeName) : undefined;
      if (!block) {
        updates.push({ source: "page", typeName, id: pageId, value: null });
        continue;
      }
      const checked = checkPageFactBlock(block, input.spaceCatalog);
      updates.push({ source: "page", typeName, id: pageId, value: checked.ok ? checked.value : null });
    }
  }
  return updates;
}

/**
 * Seeds a newly started (or revised) program's ledger with all currently held
 * `norn 1 facts <Type>` blocks across Space Pages that the program's authority
 * can edit (`canEdit === true`). Non-editable pages are skipped by the
 * permission gate so another user's page cannot steer the program's authority.
 */
export async function seedPageFactsForProgram(
  env: Env,
  input: {
    spaceId: string;
    channelId: string;
    programId: string;
    pageId?: string | null;
    pageName?: string | null;
    authorityUserId: string;
    holdKinds: readonly string[];
  },
): Promise<void> {
  const wantedTypes = pageTypeNamesFromKinds(input.holdKinds);
  if (!wantedTypes.length) return;
  const db = database(env);
  const principal: PagePrincipal = { kind: "user", id: input.authorityUserId };
  const pages = new PostgresPageRepository(db);
  const [{ pages: libPages }, { pages: factPages }] = await Promise.all([
    pages.libraryPages({ requestId: crypto.randomUUID(), spaceId: input.spaceId, principal }),
    pages.factPages({ requestId: crypto.randomUUID(), spaceId: input.spaceId, principal }),
  ]);
  const spaceCatalog = collectSpaceLibraries(libPages);
  const wantedSet = new Set(wantedTypes);
  const holds: NornHoldUpdate[] = [];
  for (const page of factPages) {
    // Permission gate: only Pages editable by the program's authority directly seed Holds.
    if (!page.canEdit) continue;
    for (const block of nornFactBlocks(page.body)) {
      if (!wantedSet.has(block.typeName)) continue;
      const checked = checkPageFactBlock(block, spaceCatalog);
      if (!checked.ok) continue;
      holds.push({ source: "page", typeName: block.typeName, id: page.pageId, value: checked.value });
    }
  }
  if (!holds.length) return;
  const requestId = `norn-facts-seed:${input.programId}:${crypto.randomUUID()}`;
  const repo = new PostgresNornProgramRepository(db, await postgresMessageRoute(env, input.channelId, requestId, { database: db }));
  const stepResult = await repo.advance(
    { requestId, channelId: input.channelId, programId: input.programId },
    nornStep(undefined, undefined, { holds }),
  );
  await ensureAndWakeNornBranches(env, {
    spaceId: input.spaceId,
    pageId: input.pageId,
    pageName: input.pageName,
    programChannelId: input.channelId,
    authorityUserId: input.authorityUserId,
    branches: stepResult?.branches,
    wakeChannels: [input.channelId, ...(stepResult?.wakeChannels ?? [])],
  });
}

/**
 * Propagates `norn 1 facts <Type>` changes (or Page deletion) on one Page to
 * every running program in the Space holding `page:<Type>`:
 * - Permission gate: only applies directly when the program's `authorityUserId`
 *   has `canEdit` on `pageId` (or when `deleted` is true, retracting stale facts).
 * - Anti-self-trigger: passes `editorConversationId` into `nornStep` so edits
 *   authored from the program's own conversation (or branch conversations) call
 *   `hold(..., { notify: false })`, updating values for the next `sample` without
 *   waking `Holds.changes`.
 * - Broken fact blocks on a live edit are skipped rather than retracted, so a
 *   mid-typing syntax error never cancels an active branch.
 */
export async function syncPageFacts(
  env: Env,
  input: {
    spaceId: string;
    pageId: string;
    editorConversationId?: string;
    deleted?: boolean;
  },
): Promise<void> {
  const db = database(env);
  const holding = await readHoldingNornPrograms(db, {
    requestId: crypto.randomUUID(), spaceId: input.spaceId, sourcePrefix: PAGE_HOLD_PREFIX,
  });
  if (!holding.length) return;

  const pages = new PostgresPageRepository(db);
  const catalogCache = new Map<string, Promise<SpaceLibraryCatalog>>();
  const accessCache = new Map<string, Promise<{ canEdit: boolean; body: string } | null>>();

  const loadForAuthority = (authorityUserId: string) => {
    let cached = accessCache.get(authorityUserId);
    if (!cached) {
      const principal: PagePrincipal = { kind: "user", id: authorityUserId };
      cached = (async () => {
        try {
          const access = await pages.access({
            requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId, principal,
          });
          if (!access.canEdit) return { canEdit: false, body: "" };
          const { page } = await pages.read({
            requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId, principal,
          });
          return { canEdit: true, body: page.body };
        } catch {
          return null;
        }
      })();
      accessCache.set(authorityUserId, cached);
    }
    return cached;
  };

  const catalogForAuthority = (authorityUserId: string) => {
    let cached = catalogCache.get(authorityUserId);
    if (!cached) {
      const principal: PagePrincipal = { kind: "user", id: authorityUserId };
      cached = pages.libraryPages({ requestId: crypto.randomUUID(), spaceId: input.spaceId, principal })
        .then(res => collectSpaceLibraries(res.pages));
      catalogCache.set(authorityUserId, cached);
    }
    return cached;
  };

  for (const program of holding) {
    const wantedTypes = pageTypeNamesFromKinds(program.holdKinds);
    if (!wantedTypes.length) continue;
    const holds: NornHoldUpdate[] = [];
    if (input.deleted) {
      for (const typeName of wantedTypes) {
        holds.push({ source: "page", typeName, id: input.pageId, value: null });
      }
    } else {
      const target = await loadForAuthority(program.authorityUserId);
      // Permission gate: a program's authority must be able to edit the Page for facts to flow directly.
      if (!target || !target.canEdit) continue;
      const blocks = nornFactBlocks(target.body);
      const catalog = blocks.length ? await catalogForAuthority(program.authorityUserId) : undefined;
      for (const typeName of wantedTypes) {
        const block = blocks.find(b => b.typeName === typeName);
        if (!block) {
          holds.push({ source: "page", typeName, id: input.pageId, value: null });
          continue;
        }
        const checked = checkPageFactBlock(block, catalog);
        // Never retract a running branch on a mid-edit syntax/type error; keep last valid held value.
        if (!checked.ok) continue;
        holds.push({ source: "page", typeName, id: input.pageId, value: checked.value });
      }
    }
    if (!holds.length) continue;
    try {
      const requestId = `norn-facts-sync:${input.pageId}:${program.programId}:${crypto.randomUUID()}`;
      const repo = new PostgresNornProgramRepository(db, await postgresMessageRoute(env, program.channelId, requestId, { database: db }));
      const stepResult = await repo.advance(
        { requestId, channelId: program.channelId, programId: program.programId },
        nornStep(undefined, undefined, {
          holds,
          ...(input.editorConversationId ? { editorConversationId: input.editorConversationId } : {}),
        }),
      );
      if (stepResult?.branches?.length || stepResult?.wakeChannels?.length) {
        await ensureAndWakeNornBranches(env, {
          spaceId: input.spaceId,
          pageId: program.pageId,
          pageName: program.pageName,
          programChannelId: program.channelId,
          authorityUserId: program.authorityUserId,
          branches: stepResult.branches,
          wakeChannels: stepResult.wakeChannels,
        });
      }
    } catch (error) {
      console.warn("Norn page facts sync failed for program", {
        spaceId: input.spaceId, pageId: input.pageId, programId: program.programId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
