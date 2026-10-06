import { cn } from "@/lib/utils";
import { COUNT_CHIP_MATERIAL_CLASS } from "@/components/dashboard/workspace-shell-constants";

/* One status vocabulary for the whole app.

   The app is monochrome plus a single brass accent, and `globals.css` enforces
   that with a sweep that rewrites every `amber-*` / `emerald-*` / `sky-*` /
   `orange-*` utility to grey. So a state written as a Tailwind colour renders
   as no state: for a long time "Review required" and "cli" sat side by side on
   the Agents page as two identical grey pills, because the only thing telling
   them apart was a `text-amber-700` the sweep had already flattened.

   A state is therefore told in ink on the shared chip material, and these are
   the only four tones there are:

     attention  brass — a person has to do something
     settled    plain ink — nothing to do; this is the resting state
     secondary  stepped back — true, but not what you are here for
     alert      this cannot proceed

   There is no "ok"/"success" tone on purpose. "Fine" is the resting state and
   is said by not being marked at all. */
export type StatusTone = "settled" | "attention" | "secondary" | "alert";

const CHIP_TONE_CLASS: Record<StatusTone, string> = {
  settled: "",
  attention: "app-status-chip-attention",
  secondary: "app-status-chip-secondary",
  alert: "app-status-chip-alert",
};

const NOTICE_TONE_CLASS: Record<StatusTone, string> = {
  settled: "app-notice-settled",
  attention: "app-notice-attention",
  secondary: "app-notice-settled",
  alert: "app-notice-alert",
};

/** A chip-scale status label: the shared chip glass plus one of the four inks. */
export function statusChipClass(tone: StatusTone = "settled", className?: string): string {
  return cn(
    "app-status-chip px-2 py-0.5 text-xs font-bold",
    COUNT_CHIP_MATERIAL_CLASS,
    CHIP_TONE_CLASS[tone],
    className
  );
}

/** Ink on a bare run of text, for a warning that was never a box. */
export function statusInkClass(tone: StatusTone = "settled", className?: string): string {
  return cn(
    tone === "attention" ? "app-ink-attention" : undefined,
    tone === "secondary" ? "app-ink-secondary" : undefined,
    tone === "alert" ? "text-destructive" : undefined,
    className
  );
}

/** A block-scale notice: flat neutral surface, tone carried by an inset rail. */
export function noticeClass(tone: StatusTone = "attention", className?: string): string {
  return cn(
    "app-notice rounded-md border px-3 py-2 text-sm",
    NOTICE_TONE_CLASS[tone],
    className
  );
}
