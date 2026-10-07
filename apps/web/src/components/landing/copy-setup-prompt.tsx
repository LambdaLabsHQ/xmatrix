"use client";

import { Check, Copy } from "lucide-react";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { quickStartSeedPrompt } from "@/lib/quick-start";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

/** Copies the setup prompt a person pastes into Claude Code, Codex or any assistant. */
export function CopySetupPrompt() {
  const { copied, copy } = useCopyToClipboard(quickStartSeedPrompt);

  return (
    <LiquidGlassPill
      as="button"
      type="button"
      onClick={copy}
      title={quickStartSeedPrompt}
      className="inline-flex h-12 items-center justify-center gap-2 px-6 text-sm font-semibold"
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? "Copied. Paste it into your agent" : "Copy the setup prompt for your agent"}
    </LiquidGlassPill>
  );
}
