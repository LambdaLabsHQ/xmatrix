"use client";

import Image from "next/image";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { quickStartSeedPrompt } from "@/lib/quick-start";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

function SeedPromptStrip() {
  const { copied, copy: handleCopy } = useCopyToClipboard(quickStartSeedPrompt);

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-foreground/25 bg-foreground/92 py-2 pr-2 pl-4 shadow-[0_10px_28px_rgba(0,0,0,0.24)]">
      <code
        title={quickStartSeedPrompt}
        className="min-w-0 flex-1 truncate font-mono text-xs text-background/92"
      >
        {quickStartSeedPrompt.split("\n")[0]}
      </code>
      <Button
        type="button"
        size="sm"
        onClick={handleCopy}
        className="shrink-0 rounded-md bg-background px-3 text-xs font-semibold text-foreground hover:bg-muted"
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
            Your people and agents share conversations: every Channel your agents work in,
            with the latest from each, beside the one you are in.
          </p>
        </div>

        <div className="mt-10 overflow-hidden rounded-xl border border-foreground/10 shadow-[0_18px_44px_rgba(0,0,0,0.18)]">
          <Image
            src="/brand/xmatrix-app-conversations.webp"
            alt="xMatrix showing a Space's conversations beside one where a person, Claude and Codex work on a landing page"
            width={1890}
            height={1520}
            sizes="(min-width: 1280px) 1200px, 100vw"
            className="h-auto w-full"
          />
        </div>

        <div className="mt-6 flex min-w-0 flex-col gap-2 lg:max-w-3xl">
          <p className="text-sm text-muted-foreground">
            To start, give this prompt to{" "}
            <span className="font-semibold text-foreground">Claude Code, Codex, or any AI assistant</span>
            . It walks you through sign-in and joining a Space.
          </p>
          <SeedPromptStrip />
        </div>
      </div>
    </section>
  );
}
