"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type ChannelApprovalSummary = { key: string; agent: string; what: string };

/**
 * The Channel's Pending approvals, docked above the composer. On a phone the
 * full cards take up to 40% of the screen, so the dock collapses to one line
 * per request that still says who is waiting and on what. Collapsing covers
 * the requests visible at that moment: a request that arrives later reopens
 * the dock, so nothing new waits out of sight.
 */
export function ChannelApprovalsDock({ summaries, status, children }: {
  summaries: ChannelApprovalSummary[];
  status?: ReactNode;
  children: ReactNode;
}) {
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string> | null>(null);
  const collapsed = collapsedKeys !== null && summaries.length > 0
    && summaries.every((summary) => collapsedKeys.has(summary.key));

  return (
    <section aria-label="Pending approvals" className={cn(
      "app-channel-approvals pointer-events-auto overflow-y-auto overscroll-contain rounded-md bg-background p-2 shadow-md",
      collapsed ? "max-h-[30dvh]" : "max-h-[40dvh]",
    )}>
      <h2 className="text-xs font-bold">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsedKeys(collapsed ? null : new Set(summaries.map((summary) => summary.key)))}
          className="flex w-full items-center gap-1.5 text-left"
        >
          <span className="flex-1">
            Pending approvals{summaries.length > 0 ? ` · ${summaries.length}` : ""}
          </span>
          <span className="text-[11px] font-semibold text-muted-foreground">{collapsed ? "Show" : "Hide"}</span>
          <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-180")} />
        </button>
      </h2>
      {status}
      {collapsed ? (
        <ul className="app-channel-approvals-summary mt-1 space-y-0.5 text-xs">
          {summaries.map((summary) => (
            <li key={summary.key} className="flex min-w-0 gap-1.5">
              <span className="shrink-0 font-semibold">{summary.agent}</span>
              <span className="min-w-0 truncate font-mono text-muted-foreground">{summary.what}</span>
            </li>
          ))}
        </ul>
      ) : children}
    </section>
  );
}
