"use client";

import { useState } from "react";
import type { AgentRuntimeIssue, AgentRuntimeNotice as RuntimeNotice } from "@xmatrix/protocol";
import { cn } from "@/lib/utils";
import { statusInkClass } from "@/components/ui/status-tone";

export function agentRuntimeIssuePhrase(issue: AgentRuntimeIssue, now: number): string {
  const subject = issue.kind === "retrying" ? "Connection retrying"
    : issue.kind === "failed" ? "Turn failed" : "No runtime progress";
  const minutes = Math.floor(Math.max(0, now - issue.sinceMillis) / 60_000);
  return `${subject} · ${minutes < 1 ? "<1m" : `${minutes}m`}`;
}

export function agentRuntimeNoticePhrase(notice: RuntimeNotice): string {
  return notice.severity === "error" ? "Agent error notice"
    : notice.severity === "warning" ? "Agent warning"
    : notice.severity === "info" ? "Agent information" : "Agent notice";
}

/** Presence carries safe, bounded symptoms; the exact diagnostic is in Trace. */
export function AgentRuntimeNotice({ issue, notice, now, onOpenTrace }: {
  issue?: AgentRuntimeIssue;
  notice?: RuntimeNotice;
  now: number;
  onOpenTrace: () => void;
}) {
  const [dismissed, setDismissed] = useState<number>();
  const visibleNotice = notice && dismissed !== notice.sinceMillis ? notice : undefined;
  const entries = [
    ...(issue ? [{key:"issue",kind:issue.kind,severity:undefined,phrase:agentRuntimeIssuePhrase(issue,now),error:issue.kind==="failed",attention:true,dismiss:undefined}] : []),
    ...(visibleNotice ? [{key:"notice",kind:undefined,severity:visibleNotice.severity,phrase:agentRuntimeNoticePhrase(visibleNotice),error:visibleNotice.severity==="error",attention:visibleNotice.severity==="warning",dismiss:()=>setDismissed(visibleNotice.sinceMillis)}] : []),
  ];
  return <>{entries.map(entry => (
    <span key={entry.key} data-runtime-issue={entry.kind} data-runtime-notice={entry.severity}
      role={entry.error ? "alert" : "status"}
      className={cn("ml-1.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background/90 px-2 py-0.5 text-[11px] font-medium",
        entry.error ? "text-destructive" : entry.attention ? statusInkClass("attention") : "text-muted-foreground")}>
      <button type="button" title={`${entry.phrase}. Open Trace for details.`} onClick={(event) => { event.stopPropagation(); onOpenTrace(); }}>{entry.phrase}</button>
      {entry.dismiss && <button type="button" aria-label="Dismiss Agent notice" className="px-1" onClick={(event) => { event.stopPropagation(); entry.dismiss?.(); }}>×</button>}
    </span>
  ))}</>;
}
