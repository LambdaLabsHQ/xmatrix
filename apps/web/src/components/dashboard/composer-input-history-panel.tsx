"use client";

import { useLayoutEffect, useRef } from "react";
import { CompletionOptionButton, stopTouchPropagation } from "./completion-option-button";
import type { ComposerInputHistoryEntry } from "./composer-input-history";

/**
 * The input history as the composer shows it on ↑ (composer-input-history.ts): the same panel and rows as the
 * mention list, oldest at the top and the newest beside the field, so ↑ climbs the list the way it points.
 */
export function ComposerInputHistoryPanel({ entries, active, onPick }: {
  entries: readonly ComposerInputHistoryEntry[];
  /** The highlighted entry, counted from the newest. */
  active: number;
  onPick: (entry: ComposerInputHistoryEntry) => void;
}) {
  const activeRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      role="listbox"
      aria-label="Sent before"
      data-testid="composer-input-history"
      className="app-mention-suggestions w-full overflow-y-auto border-b border-border/60"
      onTouchStart={stopTouchPropagation}
      onTouchMove={stopTouchPropagation}
    >
      <div className="border-b border-border/60 px-2 py-1.5 text-xs font-bold text-foreground/75">Sent before</div>
      {entries.map((_, row) => {
        const index = entries.length - 1 - row;
        const entry = entries[index]!;
        return (
          <CompletionOptionButton
            key={`${index}:${entry.body}`}
            optionRef={(node) => {
              if (index === active) activeRef.current = node;
            }}
            selected={index === active}
            onSelect={() => onPick(entry)}
            className="min-h-9 border-b border-border/30 last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate">{entry.body.replace(/\s*\n\s*/gu, " ")}</span>
          </CompletionOptionButton>
        );
      })}
    </div>
  );
}
