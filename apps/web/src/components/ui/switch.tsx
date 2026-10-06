import { cn } from "@/lib/utils"

/** The app's on/off switch: an iOS-style capsule at control size (36×20), the
 * thumb a round knob inset 2px. It acts at once, with no confirmation, since
 * switching back is one tap. The track is an inner span because the theme
 * restyles colored buttons. */
function Switch({ checked, disabled, label, onChange, className }: {
  checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void; className?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("inline-flex shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50", className)}>
      <span aria-hidden className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
        checked ? "bg-foreground" : "bg-foreground/15")}>
        <span className={cn("inline-block size-4 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.2)] transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
    </button>
  )
}

export { Switch }
