"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Redo2, Undo2, X } from "lucide-react";
import { formatRelativeAge } from "@/components/dashboard/time-display";
import { actionClass } from "@/components/ui/action-tone";
import { cn } from "@/lib/utils";
import type { PageSessionChange, PageSessionChanges, PageUndoNotice } from "./page-session-changes";

/** How long the line saying what Ctrl+Z took back stays. */
const NOTICE_MS = 5000;

const NONE: readonly PageSessionChange[] = [];
const UNSUBSCRIBED = () => () => undefined;

/** The changes since the page opened, newest first, and the last undo or redo; empty while no editor is drawn. */
export function useSessionChanges(changes: PageSessionChanges | null) {
  const subscribe = changes?.subscribe ?? UNSUBSCRIBED;
  const list = useSyncExternalStore(subscribe, () => changes?.changes ?? NONE, () => NONE);
  const notice = useSyncExternalStore(subscribe, () => changes?.notice ?? null, () => null);
  return { list, notice };
}

/** Whose change it was, as a sentence says it. */
function whose(change: PageSessionChange): string {
  if (!change.writer) return "a";
  return change.writer.self ? "your" : `${change.writer.name}'s`;
}

/** Says what Ctrl+Z just undid or redid, with the way back, for a moment after it. */
export function PageUndoNotice({ notice, changes, onShowChanges }: {
  notice: PageUndoNotice | null;
  changes: PageSessionChanges;
  /** Opens the list of changes; without it the notice offers none. */
  onShowChanges?: () => void;
}) {
  const [shown, setShown] = useState<PageUndoNotice | null>(null);
  useEffect(() => {
    if (!notice) return;
    setShown(notice);
    const hide = window.setTimeout(() => setShown((current) => current === notice ? null : current), NOTICE_MS);
    return () => window.clearTimeout(hide);
  }, [notice]);
  if (!shown) return null;
  const current = changes.changes.find((change) => change.id === shown.change.id);
  const undid = shown.kind === "undo";
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div role="status" data-testid="page-undo-notice"
        className="pointer-events-auto flex max-w-md items-center gap-3 rounded-full border bg-popover px-4 py-2 text-sm shadow-lg">
        <span className="min-w-0 truncate">{undid ? "Undid" : "Redid"} {whose(shown.change)} change</span>
        {undid ? current?.redoable && (
          <button type="button" className={actionClass({ variant: "quiet", size: "sm" })}
            onClick={() => changes.redoTo(shown.change.id)}>Redo</button>
        ) : current?.undoable && (
          <button type="button" className={actionClass({ variant: "quiet", size: "sm" })}
            onClick={() => changes.undoTo(shown.change.id)}>Undo</button>
        )}
        {onShowChanges && (
          <button type="button" className={actionClass({ variant: "quiet", size: "sm" })} onClick={onShowChanges}>Changes</button>
        )}
      </div>
    </div>
  );
}

function ChangeRow({ change, changes }: { change: PageSessionChange; changes: PageSessionChanges }) {
  const undone = change.state === "undone";
  const age = formatRelativeAge(new Date(change.at).toISOString()) ?? "";
  const name = change.writer?.name ?? "Someone";
  return (
    <li className={cn("group rounded-md px-2 py-1.5 hover:bg-accent", undone && "text-muted-foreground")}
      data-testid="page-session-change" data-state={change.state}>
      <div className="flex items-center gap-1.5 text-xs">
        <span className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: change.writer?.color ?? "var(--muted-foreground)" }} />
        <span className="min-w-0 truncate font-semibold text-foreground">{name}</span>
        <span className="shrink-0 text-muted-foreground">{age}</span>
        {undone && <span className="shrink-0 italic text-muted-foreground">· Undone</span>}
        <span className="flex-1" />
        {change.undoable && (
          <button type="button" title="Undo this change and every one after it" aria-label={`Undo ${name}'s change`}
            className={actionClass({ variant: "quiet", size: "icon-sm" }, "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
            onClick={() => changes.undoTo(change.id)}><Undo2 /></button>
        )}
        {change.redoable && (
          <button type="button" title="Redo this change and every undone one before it" aria-label={`Redo ${name}'s change`}
            className={actionClass({ variant: "quiet", size: "icon-sm" }, "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
            onClick={() => changes.redoTo(change.id)}><Redo2 /></button>
        )}
      </div>
      <p className={cn("mt-0.5 line-clamp-2 text-[13px] [overflow-wrap:anywhere]", undone && "line-through")}>
        {change.added && <span>{change.added}</span>}
        {change.added && change.removed && " "}
        {change.removed && <span className="text-muted-foreground line-through">{change.removed}</span>}
        {!change.added && !change.removed && <span className="text-muted-foreground">Formatting</span>}
      </p>
    </li>
  );
}

/**
 * Every change since this person opened the page, theirs and everyone else's, newest first: what Ctrl+Z steps back
 * through. An undo is a revert written like any change, so what it undid stays listed, marked undone.
 */
export function PageSessionChangesList({ list, changes, onClose }: {
  list: readonly PageSessionChange[];
  changes: PageSessionChanges;
  onClose?: () => void;
}) {
  return (
    <section className="space-y-1" data-testid="page-session-changes" aria-labelledby="page-session-changes-title">
      {onClose && (
        <div className="flex items-center gap-2 px-2">
          <h2 id="page-session-changes-title" className="flex-1 text-sm font-semibold">Changes since you opened</h2>
          <button type="button" aria-label="Close changes" className={actionClass({ variant: "quiet", size: "icon-sm" })}
            onClick={onClose}><X /></button>
        </div>
      )}
      {list.length ? (
        <ul className="space-y-0.5">
          {list.map((change) => <ChangeRow key={change.id} change={change} changes={changes} />)}
        </ul>
      ) : (
        <p className="px-2 text-sm text-muted-foreground">No one has changed the page since you opened it.</p>
      )}
    </section>
  );
}
