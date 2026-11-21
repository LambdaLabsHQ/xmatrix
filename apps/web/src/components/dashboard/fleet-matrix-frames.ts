/* Shared layout boxes for the Agents / Status destination (desktop matrix and
   mobile avatar matrix). Both the live matrix and its loading skeleton read
   these definitions, so the skeleton cannot drift from the content it stands in for. */

import type { CSSProperties } from "react";

export const FLEET_HERO_CLASS = "app-status-hero mb-7";
export const FLEET_HERO_TITLE_CLASS = "text-2xl font-black tracking-[-0.02em] text-foreground";
export const FLEET_HERO_SUMMARY_CLASS = "mt-1.5 text-sm text-muted-foreground";

export const FLEET_MATRIX_WRAPPER_CLASS = "relative -mx-2";
export const FLEET_MATRIX_SCROLL_CLASS = "app-fleet-matrix overflow-x-auto";
export const FLEET_MATRIX_TABLE_CLASS = "w-full border-separate border-spacing-0 text-sm";

export const FLEET_MATRIX_MACHINE_TH_CLASS =
  "w-56 min-w-[12.5rem] max-w-[16rem] border-b border-foreground/10 pb-2.5 pl-2 pr-3 text-left align-bottom";
export const FLEET_MATRIX_MACHINE_LABEL_CLASS =
  "text-[11px] font-bold uppercase tracking-wider text-muted-foreground/80";

export const FLEET_MATRIX_COLUMN_TH_CLASS =
  "border-b border-foreground/10 px-0.5 pb-1.5 text-left align-bottom font-normal";
export const FLEET_MATRIX_COLUMN_FILLER_WIDTH_CLASS = "w-[7.5rem] min-w-[6.75rem]";
export const FLEET_MATRIX_COLUMN_COMPACT_WIDTH_CLASS = "min-w-[5.75rem]";
export const FLEET_MATRIX_COLUMN_HEADING_CLASS = "flex w-full min-w-0 flex-col items-start gap-1.5 px-2 py-1.5";
export const FLEET_MATRIX_COLUMN_NAME_CLASS = "block w-full truncate text-[13px] font-semibold tracking-[-0.01em]";

export const FLEET_MATRIX_MACHINE_HEADING_CLASS = "flex w-full min-w-0 items-center gap-2.5 px-2 py-1.5 text-left";
export const FLEET_MATRIX_MACHINE_NAME_CLASS =
  "block truncate text-[15px] font-semibold leading-snug tracking-[-0.01em] text-foreground";
export const FLEET_MATRIX_MACHINE_FACTS_CLASS = "mt-0.5 block truncate text-xs leading-tight text-muted-foreground";

export const FLEET_MATRIX_ROW_TH_CLASS = "border-b border-foreground/10 py-2 pr-3 text-left align-middle font-normal";
export const FLEET_MATRIX_CELL_TD_CLASS = "border-b border-foreground/10 px-0.5 py-2 align-middle";
export const FLEET_MATRIX_CELL_CLASS =
  "flex min-h-12 w-full min-w-0 flex-col justify-center gap-1 rounded-md px-2 py-1.5 text-left transition-colors";
export const FLEET_MATRIX_CELL_LINE_CLASS = "flex w-full min-w-0 items-center gap-1.5 text-[12.5px] leading-snug";

export const MOBILE_FLEET_LIST_CONTAINER_CLASS =
  "px-[var(--mobile-content-inset,1rem)] pt-2 pb-[calc(6.5rem+var(--app-safe-area-bottom))]";
export const MOBILE_MATRIX_ROOT_CLASS = "space-y-1";
export const MOBILE_MATRIX_SECTION_CLASS = "py-2.5";
export const MOBILE_MATRIX_HEADING_CLASS = "flex w-full min-w-0 items-center gap-2 pb-1.5 text-left";
export const MOBILE_MATRIX_MACHINE_NAME_CLASS =
  "max-w-[62%] shrink-0 truncate text-[15px] font-bold tracking-tight text-foreground";
export const MOBILE_MATRIX_CELL_CLASS = "flex flex-col items-center justify-center gap-1 rounded-xl py-1";

export function mobileMatrixGridStyle(slotCount: number): CSSProperties {
  const safe = Math.max(slotCount, 1);
  return slotCount > 8
    ? { gridTemplateColumns: `repeat(${slotCount}, 2.75rem)` }
    : { gridTemplateColumns: `repeat(${safe}, min(2.75rem, calc(100% / ${safe})))` };
}
