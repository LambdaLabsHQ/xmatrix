import { cn } from "@/lib/utils";

/* One action vocabulary for the whole app — the sibling of `status-tone.ts`.

   The theme layer already paints every action the same raised glass, but it
   did so by guessing at whatever utilities the call site happened to write
   (`.inline-flex.rounded-md.border`, `button.bg-foreground`, …). That made the
   material uniform and left the *geometry* to 150 hand-copied class strings,
   so the board shipped three heights and three paddings for one kind of
   button: "New agent" was 40px tall with 12px of padding, "New secret" and
   "Sign out" beside it were 36px, and "Connect GitHub" carried 16px. Nothing
   chose any of that; each line was copied from the one above it.

   Guessing at utilities also decides who is allowed into the vocabulary at
   all: the radius rule is scoped to `.app-tool-surface`, so the setup cards on
   Projects and Security — the same buttons, one wrapper away — rendered at
   4px while the whole board was at 12px.

   So an action carries a real class, `app-action`, and the theme keys on that.
   Geometry lives here; material lives in the `.app-action*` rules. */

export type ActionVariant = "primary" | "secondary" | "danger" | "quiet";

/** Text sizes are the board's own scale; `lg` is the phone's touch target. */
export type ActionSize = "sm" | "md" | "lg" | "icon-sm" | "icon" | "icon-lg";

const VARIANT_CLASS: Record<ActionVariant, string> = {
  primary: "app-action-primary",
  secondary: "app-action-secondary",
  danger: "app-action-danger",
  quiet: "app-action-quiet",
};

const SIZE_CLASS: Record<ActionSize, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-xs",
  md: "h-9 gap-2 px-3 text-sm",
  lg: "h-10 gap-2 px-4 text-sm",
  "icon-sm": "size-7",
  icon: "size-8",
  "icon-lg": "size-9",
};

export type ActionOptions = {
  variant?: ActionVariant;
  size?: ActionSize;
};

/**
 * The class for one action. `className` is for layout at the call site —
 * `w-full`, `shrink-0`, grid placement — never for material or size.
 */
export function actionClass(
  { variant = "secondary", size = "md" }: ActionOptions = {},
  className?: string
): string {
  return cn(
    "app-action inline-flex shrink-0 items-center justify-center rounded-md font-bold whitespace-nowrap",
    "disabled:pointer-events-none disabled:opacity-50",
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    className
  );
}
