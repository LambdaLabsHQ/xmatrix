"use client";

import { AlertTriangle } from "lucide-react";
import type { AgentFailureEvidence } from "@xmatrix/protocol";
import { turnFailureSummary, turnProblem } from "./turn-failure";
import { useOnboardingLocale } from "@/lib/onboarding-locale";
import { PROBLEM_COPY } from "@/lib/problem-copy";
import { ProblemCard } from "./problem-card";

/* The original error leads. Recorded evidence supplies next steps, never a
   replacement for the program's own cause. Full diagnostics stay in Details. */
export function TurnFailureNotice({ evidence, agent, body, continued = false, spaceId, token, userId }: {
  evidence: AgentFailureEvidence;
  /** The Agent as the Channel names it. */
  agent: string;
  body: string;
  /** That Agent posted its own later message, so this turn is no longer waiting on a reply. */
  continued?: boolean;
  spaceId: string | null; token: string | null; userId: string;
}) {
  const locale = useOnboardingLocale(spaceId, token, userId);
  const copy = PROBLEM_COPY[locale];
  const problemKey = turnProblem(evidence);
  const problem = copy.turn[problemKey];
  const summary = turnFailureSummary(body);
  const resetsAt = evidence.usageLimit?.resetsAt;
  const reset = resetsAt ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(resetsAt)) + " UTC" : undefined;
  return (
    <ProblemCard icon={<AlertTriangle className="size-[18px]" />}
      title={summary || problem.title(agent)}
      explanation={reset ? copy.quotaResets(reset) : !summary ? problem.explanation || copy.noProviderDetail : undefined}
      {...(continued ? { status: { resolved: true, label: copy.turn.continued(agent) } }
        : { stepsLabel: problemKey === "no_status" ? copy.turn.continueLabel : copy.stepsLabel, steps: problem.steps })}
      detailsLabel={copy.detailsLabel}
      details={<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{body}</pre>} />
  );
}
