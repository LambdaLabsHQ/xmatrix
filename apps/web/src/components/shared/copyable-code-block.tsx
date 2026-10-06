"use client";

import { Check, Copy } from "lucide-react";
import { LiquidGlassCard, MaterialChip } from "@/components/ui/material-surfaces";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

export function CopyableCodeBlock({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const { copied, copy: handleCopy } = useCopyToClipboard(code);

  return (
    <LiquidGlassCard className="min-w-0">
      <div className="flex items-start gap-3 p-4 sm:px-6 sm:py-5">
        <pre
          className={cn(
            "min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed text-foreground selection:bg-primary/30",
            className
          )}
        >
          <code>{code}</code>
        </pre>
        <MaterialChip
          as="button"
          type="button"
          onClick={handleCopy}
          className="h-7 shrink-0 cursor-pointer px-2 text-[10px] font-semibold"
        >
          {copied ? (
            <>
              <Check className="mr-1 size-3 text-primary" />
              Copied
            </>
          ) : (
            <>
              <Copy className="mr-1 size-3" />
              Copy
            </>
          )}
        </MaterialChip>
      </div>
    </LiquidGlassCard>
  );
}
