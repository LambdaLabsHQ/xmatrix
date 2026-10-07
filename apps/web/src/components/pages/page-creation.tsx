"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CenteredDialogShell, DialogButton, DialogPanelFooter, DialogPanelHeader,
} from "@/components/dashboard/centered-dialog-shell";
import { Input } from "@/components/ui/input";
import { pageApi } from "@/lib/pages/page-client";

export type PageCreation = ReturnType<typeof usePageCreation>;

/** Shared by the tree and existing phone FAB; native WebViews cannot rely on window.prompt. */
export function usePageCreation(spaceId: string | null, token: string, onCreated: (pageId: string) => void) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<{ parentPageId: string | null; title: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const currentSpace = useRef(spaceId);
  useEffect(() => {
    currentSpace.current = spaceId;
    setDraft(null);
    setError(null);
  }, [spaceId]);

  const create = useCallback((parentPageId: string | null) => {
    if (!spaceId || inFlight.current) return;
    setError(null);
    setDraft({ parentPageId, title: "" });
  }, [spaceId]);
  const cancel = useCallback(() => {
    if (inFlight.current) return;
    setDraft(null);
    setError(null);
  }, []);
  const setTitle = useCallback((title: string) => {
    setDraft((value) => value ? { ...value, title } : null);
  }, []);
  const submit = useCallback(async () => {
    if (!draft?.title.trim() || !spaceId || inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    setError(null);
    try {
      const { page } = await pageApi.create(spaceId, token, {
        title: draft.title.trim(), parentPageId: draft.parentPageId,
      });
      await queryClient.invalidateQueries({ queryKey: ["xmatrix"], predicate: (query) =>
        query.queryKey.includes("page-tree") });
      if (currentSpace.current === spaceId) {
        setDraft(null);
        onCreated(page.pageId);
      }
    } catch (cause) {
      if (currentSpace.current === spaceId) {
        setError(cause instanceof Error ? cause.message : "Could not create the page");
      }
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }, [draft, onCreated, queryClient, spaceId, token]);
  return { create, creating, error, draft, setTitle, cancel, submit };
}

/** One title picker mounted in the shell, outside both responsive page trees. */
export function PageCreationDialog({ creation }: { creation: PageCreation }) {
  const { draft, creating, error, setTitle, cancel, submit } = creation;
  return (
    <CenteredDialogShell open={draft !== null} busy={creating} labelledBy="page-create-title"
      onCancel={cancel} panelClassName="flex max-w-sm flex-col">
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <DialogPanelHeader labelledBy="page-create-title" title={draft?.parentPageId ? "New sub-page" : "New page"} />
        <div className="space-y-2 px-5 py-4">
          <label htmlFor="page-create-name" className="text-sm font-semibold">Title</label>
          <Input id="page-create-name" autoFocus value={draft?.title ?? ""}
            onChange={(event) => setTitle(event.target.value)} disabled={creating}
            aria-describedby={error ? "page-create-error" : undefined} />
          {error && <p id="page-create-error" role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogPanelFooter>
          <DialogButton onClick={cancel} disabled={creating}>Cancel</DialogButton>
          <DialogButton type="submit" tone="primary" busy={creating}
            disabled={creating || !draft?.title.trim()}>Create</DialogButton>
        </DialogPanelFooter>
      </form>
    </CenteredDialogShell>
  );
}
