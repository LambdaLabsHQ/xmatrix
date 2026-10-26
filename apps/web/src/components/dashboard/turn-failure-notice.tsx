"use client";

import { AlertTriangle } from "lucide-react";
import type { AgentFailureEvidence } from "@xmatrix/protocol";
import { turnProblem } from "./turn-failure";
import { useOnboardingLocale } from "@/lib/onboarding-locale";
import { PROBLEM_COPY } from "@/lib/problem-copy";
import { ProblemCard } from "./problem-card";

/* A turn its Agent could not finish: what the evidence says happened, what to
   do next, and the notice as written folded into Details. */
export function TurnFailureNotice({ evidence, agent, body, continued = false, spaceId, token, userId }: {
  evidence: AgentFailureEvidence;
  /** The Agent as the Channel names it. */
  agent: string;
  body: string;
  /** That Agent posted its own later message, so this turn is no longer waiting on a reply. */
  continued?: boolean;
  spaceId: string | null; token: string | null; userId: string;
}) {
  const copy = PROBLEM_COPY[useOnboardingLocale(spaceId, token, userId)];
  const problemKey = turnProblem(evidence);
  const problem = copy.turn[problemKey];
  return (
    <ProblemCard icon={<AlertTriangle className="size-[18px]" />}
      title={problem.title(agent)}
      explanation={problem.explanation || undefined}
      {...(continued ? { status: { resolved: true, label: copy.turn.continued(agent) } }
        : { stepsLabel: problemKey === "no_status" ? copy.turn.continueLabel : copy.stepsLabel, steps: problem.steps })}
      detailsLabel={copy.detailsLabel}
      details={<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{body}</pre>} />
  );
}
