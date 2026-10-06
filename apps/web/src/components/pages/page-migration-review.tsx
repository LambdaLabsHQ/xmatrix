"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type LaunchTargetRepo, type PageMigration, type PageMigrationDraftPage,
  type PageMigrationReport } from "@xmatrix/protocol";
import Markdown from "react-markdown";
import { markdownRemarkPlugins } from "@/lib/markdown-plugins";
import { FileText, Lock } from "lucide-react";
import { ContentSkeleton } from "@/components/dashboard/content-skeleton";
import { Button } from "@/components/ui/button";
import { GlassSelect } from "@/components/ui/glass-select";
import { noticeClass } from "@/components/ui/status-tone";
import { xmatrixApiRequest } from "@/lib/query/api-client";

const migrationKey = (spaceId: string) => ["xmatrix", "page-migration", spaceId];

export function usePageMigration(spaceId: string, token: string, enabled = true) {
  return useQuery<PageMigration>({
    queryKey: migrationKey(spaceId),
    enabled,
    // Until something is drafted, an Agent may be writing the draft right now.
    refetchInterval: (query) => query.state.data?.state === "none" ? 15_000 : false,
    queryFn: ({ signal }) => xmatrixApiRequest<PageMigration>({
      url: WEB_PROXY_ROUTES.space_page_migration(spaceId), token, signal }),
  });
}

/** What a Space owner asks an Agent in any conversation. */
const DRAFT_REQUEST = "Draft this Space's move to pages.";

/**
 * A Space owner's or admin's review of the move to pages
 * (docs/design/pages-and-conversations-migration.md §3): an Agent drafted a
 * new page tree from the Space's conversations; the owner reads it, drops or
 * renames pages, and applies it.
 */
export function PageMigrationReview({ spaceId, token, onApplying, onDone }: {
  spaceId: string; token: string; onApplying: () => void; onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = migrationKey(spaceId);
  const migration = usePageMigration(spaceId, token);
  // Edits belong to the draft they were made on; a newer draft replaces them.
  const [edits, setEdits] = useState<{ version: number; drop: Set<string>; titles: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (migration.isLoading) return <ContentSkeleton label="Loading" lines={6} className="p-6" />;
  if (migration.isError || !migration.data) return null;
  const data = migration.data;
  if (data.state === "applied" && data.report) return <MigrationReport report={data.report} onDone={onDone} />;
  if (data.state === "none") return <NoDraft spaceId={spaceId} token={token} />;

  const current = edits?.version === data.version ? edits : { version: data.version, drop: new Set<string>(), titles: {} };
  const rows = withDepth(data.draft.pages, current.drop);
  const changed = current.drop.size > 0 || Object.keys(current.titles).length > 0;
  const closed = new Set(data.sources.filter((source) => source.closed).map((source) => source.conversationId));
  const names = new Map(data.sources.map((source) => [source.conversationId, source.name]));

  const apply = async () => {
    onApplying();
    setBusy(true);
    setError(null);
    try {
      let draft = data;
      if (changed) {
        draft = await xmatrixApiRequest<PageMigration>({ url: `${WEB_PROXY_ROUTES.space_page_migration(spaceId)}/draft`,
          token, method: "PATCH", body: { version: data.version, drop: [...current.drop], titles: current.titles } });
        queryClient.setQueryData(queryKey, draft);
      }
      queryClient.setQueryData(queryKey, await xmatrixApiRequest<PageMigration>({
        url: `${WEB_PROXY_ROUTES.space_page_migration(spaceId)}/apply`, token, method: "POST",
        body: { version: draft.version } }));
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("page-tree") });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not move this Space to pages");
    } finally {
      setBusy(false);
    }
  };

  const kept = rows.filter(({ page }) => !current.drop.has(page.key)).length;
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6" data-testid="page-migration-review">
      <div>
        <h1 className="text-2xl font-black">Move this Space to pages</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {data.drafter?.label ?? "An Agent"} drafted these pages from the Space&apos;s conversations. Read them,
          drop or rename what you want, and publish them. Conversations stay as they are; each page links the
          ones it was written from. A page written from a closed conversation is readable only by its readers.
        </p>
      </div>
      {error && <p className={noticeClass("alert", "rounded-md px-3 py-2 text-sm")}>{error}</p>}
      <ul className="divide-y rounded-md border">
        {rows.map(({ page, depth }) => {
          // A dropped page's children stay; they move up to the nearest kept page.
          const off = current.drop.has(page.key);
          const restricted = page.sources.some((id) => closed.has(id));
          return (
            <li key={page.key} className="px-3 py-2 text-sm" style={{ paddingLeft: `${12 + depth * 16}px` }}>
              <details>
                <summary className="flex cursor-pointer items-center gap-2">
                  <FileText className="size-3.5 shrink-0" />
                  <input aria-label={`Title of ${page.title}`} disabled={off}
                    className={`min-w-0 flex-1 bg-transparent ${off ? "text-muted-foreground line-through" : "font-medium"}`}
                    value={current.titles[page.key] ?? page.title}
                    onChange={(event) => setEdits({ ...current,
                      titles: { ...current.titles, [page.key]: event.target.value } })} />
                  {restricted && <Lock aria-label="restricted" className="size-3.5 shrink-0 text-muted-foreground" />}
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input type="checkbox" checked={!current.drop.has(page.key)} onChange={() => {
                      const drop = new Set(current.drop);
                      if (drop.has(page.key)) drop.delete(page.key);
                      else drop.add(page.key);
                      setEdits({ ...current, drop });
                    }} />
                    keep
                  </label>
                </summary>
                <div className="prose prose-sm mt-2 max-w-none">
                  <Markdown remarkPlugins={markdownRemarkPlugins}>{page.body}</Markdown>
                </div>
                {page.sources.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Written from {page.sources.map((id) => names.get(id) ?? id).join(", ")}
                  </p>
                )}
              </details>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{counted(kept, "page")}</span>
        <Button disabled={busy || kept === 0} onClick={() => void apply()}>{busy ? "Publishing…" : "Move to pages"}</Button>
      </div>
    </div>
  );
}

/**
 * Nothing drafted yet: an Agent writes the draft when asked in any
 * conversation, or starts from one of the Space's GitHub repositories.
 */
function NoDraft({ spaceId, token }: { spaceId: string; token: string }) {
  const [started, setStarted] = useState<string | null>(null);
  const repositories = useQuery({
    queryKey: [...migrationKey(spaceId), "import-repositories"],
    queryFn: ({ signal }) => xmatrixApiRequest<{ repos: LaunchTargetRepo[]; repoStatus: string }>({
      url: `${WEB_PROXY_ROUTES.space_page_migration(spaceId)}/import/repositories`, token, signal }),
  });
  const [repository, setRepository] = useState("");
  const start = useMutation({
    mutationFn: (name: string) => xmatrixApiRequest<{ conversationId: string }>({
      url: `${WEB_PROXY_ROUTES.space_page_migration(spaceId)}/import`, token, method: "POST",
      body: { repository: name } }),
    onSuccess: (_result, name) => setStarted(name),
  });
  const repos = repositories.data?.repos ?? [];
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-6" data-testid="page-migration-review">
      <h1 className="text-2xl font-black">Move this Space to pages</h1>
      <p className="text-sm text-muted-foreground">
        Pages say how things stand; conversations are where work happens. An Agent reads this Space&apos;s
        conversations and memory and drafts a new page tree: current decisions, state and open work, rewritten
        briefly, each page linked to the conversations it came from. You review the draft here before anything
        is published.
      </p>
      <p className="text-sm">
        Ask an Agent in any conversation: <code className="rounded bg-muted px-1">{DRAFT_REQUEST}</code>
      </p>
      {repos.length > 0 && (
        <section className="space-y-2 border-t pt-4" data-testid="page-import">
          <h2 className="text-sm font-bold">Or start from a GitHub repository</h2>
          <p className="text-sm text-muted-foreground">
            An Agent reads its README, documents, issues and pull requests and drafts the pages.
          </p>
          {started ? (
            <p className="text-sm">An Agent is drafting pages from {started}. The draft appears here when it is ready.</p>
          ) : (
            <div className="flex gap-2">
              <GlassSelect className="min-w-0 flex-1" value={repository} aria-label="Repository"
                placeholder="Choose a repository…" onChange={setRepository}
                options={repos.map((repo) => ({ value: repo.value, label: repo.value }))} />
              <Button size="sm" disabled={!repository || start.isPending} onClick={() => start.mutate(repository)}>
                Draft pages
              </Button>
            </div>
          )}
          {start.error && <p role="alert" className="text-sm text-destructive">{start.error.message}</p>}
        </section>
      )}
    </div>
  );
}

function MigrationReport({ report, onDone }: { report: PageMigrationReport; onDone: () => void }) {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6" data-testid="page-migration-report">
      <div>
        <h1 className="text-2xl font-black">This Space now runs on pages</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {counted(report.pages, "page")} · {counted(report.links, "conversation link")}
          {report.restrictedPages > 0 ? ` · ${counted(report.restrictedPages, "restricted page")}` : ""}
        </p>
      </div>
      <Button onClick={onDone}>Open pages</Button>
    </div>
  );
}

/**
 * Draft pages in order, indented as they will be published: a kept page sits
 * under its nearest kept ancestor, as the Hub moves the children of a dropped
 * page up; a dropped page stays in place so it can be kept again.
 */
function withDepth(pages: readonly PageMigrationDraftPage[], drop: ReadonlySet<string>):
  Array<{ page: PageMigrationDraftPage; depth: number }> {
  const parentOf = new Map(pages.map((page) => [page.key, page.parentKey]));
  const depth = new Map<string, number>();
  return pages.map((page) => {
    let parent = page.parentKey;
    while (!drop.has(page.key) && parent !== null && drop.has(parent)) parent = parentOf.get(parent) ?? null;
    const value = parent === null ? 0 : (depth.get(parent) ?? -1) + 1;
    depth.set(page.key, value);
    return { page, depth: value };
  });
}

function counted(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}
