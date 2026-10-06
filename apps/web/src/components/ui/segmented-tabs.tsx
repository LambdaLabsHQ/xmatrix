"use client";

import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/* The app's one segmented control, and the only place it is styled.

   The track is a plain action-fill capsule at the 10px step, with tabs
   concentric at 7px inside it; the chosen tab takes the primary action fill.
   On a phone the track spans the row and divides it evenly, each tab never
   narrower than its own label, and track and tabs turn into one capsule.
   `.app-segmented-track` / `.app-segmented-tab` only name the parts for tests;
   no stylesheet rule keys on them. */

export type SegmentedTabItem<Key extends string> = {
  key: Key;
  label: string;
  icon?: LucideIcon;
  /** Falls back to `label`; set when the visible label is an abbreviation. */
  title?: string;
};

const SEGMENTED_TAB_CLASS = cn(
  "app-segmented-tab relative z-2 inline-flex border-0 h-9 shrink-0 items-center justify-center gap-2 rounded-[7px] px-3",
  "text-sm font-[760] whitespace-nowrap text-(--app-action-ink-muted)",
  "hover:not-aria-selected:bg-(--app-action-fill-hover) hover:not-aria-selected:text-(--app-action-ink)",
  "aria-selected:bg-(--app-action-fill-primary) aria-selected:text-(--app-action-ink) aria-selected:[backdrop-filter:var(--app-glass-filter)]",
  "aria-selected:[box-shadow:inset_0_0_0_0.5px_oklch(1_0.02_90_/_0.55),inset_0_1px_0_oklch(1_0.02_90_/_0.4)]",
  "max-md:w-full max-md:min-w-0 max-md:gap-1.5 max-md:rounded-[999px] max-md:px-1.5 max-md:text-[0.75rem] max-md:[&_svg]:size-[0.9375rem]"
);

/* The tabs never wrap (`whitespace-nowrap`), so a desktop track narrower than
   its labels clips them; the header it sits in wraps the whole control onto
   its own line first. On a phone the track scrolls sideways instead. */
const SEGMENTED_TRACK_CLASS = cn(
  "app-segmented-track inline-flex w-fit max-w-full shrink-0 items-center overflow-hidden rounded-[10px] border border-transparent p-[2px]",
  "bg-(--app-action-fill) [box-shadow:var(--app-action-edge)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
  "max-md:grid max-md:h-11 max-md:w-full max-md:auto-cols-[minmax(max-content,1fr)] max-md:grid-flow-col max-md:gap-0.5 max-md:overflow-x-auto max-md:rounded-[999px]"
);

export function SegmentedTabs<Key extends string>({
  items,
  value,
  onChange,
  label,
  className,
  tabClassName,
}: {
  items: readonly SegmentedTabItem<Key>[];
  value: Key;
  onChange: (key: Key) => void;
  /** Names the group for assistive tech, e.g. "Agent workspace". */
  label: string;
  className?: string;
  tabClassName?: string;
}) {
  return (
    <div className={cn(SEGMENTED_TRACK_CLASS, className)} role="tablist" aria-label={label}>
      {items.map(({ key, label: itemLabel, icon: Icon, title }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          title={title ?? itemLabel}
          onClick={() => onChange(key)}
          className={cn(SEGMENTED_TAB_CLASS, tabClassName)}
        >
          {Icon ? <Icon className="size-4" /> : null}
          {itemLabel}
        </button>
      ))}
    </div>
  );
}
