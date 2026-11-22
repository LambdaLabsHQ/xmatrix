"use client";

import { AlertTriangle } from "lucide-react";
import { startupFailureWords } from "@xmatrix/protocol";
import { useReaderLocale } from "@/lib/onboarding-locale";
import { PROBLEM_COPY } from "@/lib/problem-copy";
import { ProblemCard } from "./problem-card";

/* A Run its machine began and could not bring up, worded from the code the
   Hub recorded (metadata failureCode, problem-catalog.ts STARTUP_FAILURES).
   The machine's own error is the cause and is shown as written; the stage it
   stopped at and the code stay in Details. */
export function StartupFailureProblem({ code, agent, machine, cause, phase }: {
  code: string; agent: string; machine?: string; cause?: string; phase?: string;
}) {
  const locale = useReaderLocale();
  const copy = PROBLEM_COPY[locale];
  const words = startupFailureWords(code, locale, { agent, machine });
  return <ProblemCard icon={<AlertTriangle className="size-4" />} title={words.title}
    explanation={<>{words.explanation}{cause ? <span className="mt-1 block font-mono text-[12px] text-foreground [overflow-wrap:anywhere]">{cause}</span> : null}</>}
    stepsLabel={copy.stepsLabel} steps={words.steps} detailsLabel={copy.detailsLabel}
    details={<>{phase ? <p>{locale === "zh" ? `停在：${phase}` : `Stopped at: ${phase}`}</p> : null}<p>{copy.errorCode(code)}</p></>} />;
}
