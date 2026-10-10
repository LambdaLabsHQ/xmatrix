"use client";

import { useState, type ReactNode } from "react";
import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { ListSectionHeading } from "./list-section-heading";

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
      // The heading is a list's; here its rows start at the sheet's own edge.
      "app-channel-approvals pointer-events-auto overflow-y-auto overscroll-contain px-3 py-2.5",
      "[--app-list-row-end:0px] [--app-list-row-start:0px]",
      collapsed ? "max-h-[30dvh]" : "max-h-[40dvh]",
    )}>
      <ListSectionHeading
        label="Pending approvals"
        count={summaries.length > 0 ? summaries.length : undefined}
        mark={{ icon: Bell, tone: "attention" }}
        action={{
          label: collapsed ? "Show" : "Hide",
          expanded: !collapsed,
          onClick: () => setCollapsedKeys(collapsed ? null : new Set(summaries.map((summary) => summary.key))),
        }}
      />
      {status}
      {collapsed ? (
        <ul className="app-channel-approvals-summary mt-1.5 space-y-0.5 text-xs">
          {summaries.map((summary) => (
            <li key={summary.key} className="flex min-w-0 gap-1.5">
              <span className="shrink-0 font-semibold">{summary.agent}</span>
              <span className="min-w-0 truncate text-muted-foreground">{summary.what}</span>
            </li>
          ))}
        </ul>
      ) : children}
    </section>
  );
}
