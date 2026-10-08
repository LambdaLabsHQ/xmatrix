import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Search: a small lens on a long, heavier handle, after SF Symbols'
 * magnifyingglass. Lucide's lens is large and its handle short, so at 16px it
 * reads as the letter Q rather than a magnifier.
 */
export function SearchGlyph({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className={cn("app-search-glyph", className)}
      {...props}
    >
      <circle cx="10" cy="10" r="6.5" />
      <path d="M15 15l5.5 5.5" strokeWidth={2.6} />
    </svg>
  );
}
