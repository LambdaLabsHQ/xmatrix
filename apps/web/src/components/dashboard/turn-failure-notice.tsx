"use client";

import { AlertTriangle } from "lucide-react";
import type { AgentFailureEvidence } from "@xmatrix/protocol";
import { turnFailureSummary, turnProblem } from "./turn-failure";
import { useOnboardingLocale } from "@/lib/onboarding-locale";
import { PROBLEM_COPY } from "@/lib/problem-copy";
import { ProblemCard } from "./problem-card";

/* A turn its Agent could not finish: what the evidence says happened, what to
   do next, and the notice as written folded into Details. */
export function TurnFailureNotice({ evidence, agent, body, spaceId, token, userId }: {
  evidence: AgentFailureEvidence;
  /** The Agent as the Channel names it. */
  agent: string;
  body: string;
  spaceId: string | null; token: string | null; userId: string;
}) {
  const locale = useOnboardingLocale(spaceId, token, userId);
  const copy = PROBLEM_COPY[locale];
  const problem = copy.turn[turnProblem(evidence)];
  const summary = turnFailureSummary(body);
  const resetsAt = evidence.usageLimit?.resetsAt;
  const reset = resetsAt ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(resetsAt)) + " UTC" : undefined;
  return (
    <ProblemCard icon={<AlertTriangle className="size-[18px]" />}
      title={problem.title(agent)}
      explanation={<>
        {problem.explanation ? <span className="block">{problem.explanation}</span> : null}
        {summary ? <span className="mt-1 block whitespace-pre-wrap break-words">{copy.originalError(summary)}</span> : null}
        {reset ? <span className="mt-1 block">{copy.quotaResets(reset)}</span> : null}
        {!summary && !problem.explanation ? copy.noProviderDetail : null}
      </>}
      stepsLabel={copy.stepsLabel} steps={problem.steps}
      detailsLabel={copy.detailsLabel}
      details={<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{body}</pre>} />
  );
}
