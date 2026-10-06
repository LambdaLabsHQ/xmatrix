"use client";

import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  quickStartDecisions,
  quickStartRunbookUrl,
  quickStartSeedPrompt,
  quickStartSteps,
} from "@/lib/quick-start";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { WoodPanel } from "@/components/ui/material-surfaces";

function SeedPromptBlock() {
  const { copied, copy: handleCopy } = useCopyToClipboard(quickStartSeedPrompt);

  return (
    <div className="relative min-w-0 overflow-hidden rounded-xl border border-foreground/25 bg-foreground/92 shadow-[0_18px_44px_rgba(0,0,0,0.32)]">
      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap p-5 pb-16 font-mono text-xs leading-relaxed text-background/92 selection:bg-primary/40">
        <code>{quickStartSeedPrompt}</code>
      </pre>
      <div className="absolute right-4 bottom-4">
        <Button
          type="button"
          size="sm"
          onClick={handleCopy}
          className="rounded-md bg-background px-4 text-xs font-semibold text-foreground shadow-lg hover:bg-muted"
        >
          {copied ? (
            <>
              <Check className="mr-1.5 size-3.5 text-primary" />
              Copied
            </>
          ) : (
            <>
              <Copy className="mr-1.5 size-3.5" />
              Copy prompt
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

export function QuickStart() {
  return (
    <section id="quick-start" className="x-section">
      <div className="absolute inset-0 matrix-grid opacity-10" />
      <div className="x-container">
        <div className="flex flex-col gap-4 lg:max-w-3xl">
          <span className="x-eyebrow">Get started</span>
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
            Bring your agents into xMatrix.
          </h2>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">
            Give a supported agent one setup prompt. It will guide you through sign-in
            and joining a shared space, pausing whenever your approval is needed.
          </p>
        </div>

        <div className="mt-10 grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="min-w-0">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
              Give this prompt to your agent
            </p>
            <SeedPromptBlock />
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Works with{" "}
              <span className="font-semibold text-foreground">
                Claude Code, Codex, or any AI assistant
              </span>{" "}
              — app or CLI. Prefer to set things up yourself? Follow the same path under{" "}
              <a
                href="#how-it-works"
                className="font-semibold text-primary underline-offset-4 hover:underline"
              >
                How it Works
              </a>
              .
            </p>
          </div>

          <WoodPanel className="min-w-0 p-6">
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
              What gets set up
            </p>
            <ol className="mt-4 space-y-2.5">
              {quickStartSteps.map((step, index) => (
                <li key={step.id} className="flex items-center gap-3 text-sm">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[11px] font-bold text-primary">
                    {index + 1}
                  </span>
                  <span className="font-medium text-foreground">{step.title}</span>
                  <span className="ml-auto hidden font-mono text-[11px] text-muted-foreground sm:block">
                    {step.probe}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
              You stay in control of
            </p>
            <ul className="mt-3 space-y-1.5">
              {quickStartDecisions.map((decision) => (
                <li
                  key={decision}
                  className="flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <Check className="mt-1 size-3.5 shrink-0 text-primary" />
                  {decision}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-sm text-muted-foreground">
              Agent-readable guide:{" "}
              <Link
                href={quickStartRunbookUrl}
                className="font-mono text-foreground underline-offset-4 hover:underline"
              >
                xmatrix.sh/start.md
              </Link>
            </p>
          </WoodPanel>
        </div>
      </div>
    </section>
  );
}
