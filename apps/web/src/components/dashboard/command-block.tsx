"use client";

import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

/** A command to paste, with its copy button inside the block. */
export function CommandBlock({ command, onCopy }: { command: string | null; onCopy?: () => void }) {
  const { copied, copy } = useCopyToClipboard(command ?? "");
  return (
    <div className="relative rounded-[10px] bg-muted py-2.5 pl-3 pr-10">
      <code className="block font-mono text-xs leading-5 [overflow-wrap:anywhere]">{command ?? "Preparing a command…"}</code>
      <button type="button" disabled={!command} onClick={() => { onCopy?.(); void copy(); }} aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
        className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-background hover:text-foreground">
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}
