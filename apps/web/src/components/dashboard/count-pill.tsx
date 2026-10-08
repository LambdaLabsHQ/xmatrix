import { cn } from "@/lib/utils";
import { COUNT_CHIP_MATERIAL_CLASS } from "./workspace-shell-constants";

export function formatUnreadCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * The one count chip in the app. It has no material of its own — it wears
 * COUNT_CHIP_MATERIAL_CLASS. Only its size and numerals are its own, and those
 * live in one CSS rule keyed on `app-count-pill`.
 */
export function CountPill({
  count,
  title,
  className,
}: {
  count: number;
  title?: string;
  className?: string;
}) {
  return (
    <span title={title} className={cn("app-count-pill", COUNT_CHIP_MATERIAL_CLASS, className)}>
      <span className="app-count-pill-value">{formatUnreadCount(count)}</span>
    </span>
  );
}
