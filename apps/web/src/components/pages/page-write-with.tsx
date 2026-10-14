"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp } from "lucide-react";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { listenForOverlayDismissal } from "@/components/dashboard/use-overlay-dismiss";
import { LiquidGlassCard } from "@/components/ui/material-surfaces";
import { isImeKeyDown } from "@/lib/ime-keydown";
import { cn } from "@/lib/utils";

/** An Agent the reader can call to write the page with them: a runtime of the Space, by its own face. */
export interface WriteAgent { harness: string; avatarUrl?: string }

/** Where the Agent is asked to write: the whole page, or one section of it. */
export interface WriteTarget { blockId: string | null; section: string | null }

/** How far the on-screen keyboard covers the bottom of the window, so what sits there stays above it. */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const read = () => setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    read();
    viewport.addEventListener("resize", read);
    viewport.addEventListener("scroll", read);
    return () => { viewport.removeEventListener("resize", read); viewport.removeEventListener("scroll", read); };
  }, []);
  return inset;
}

/**
 * Calling an Agent to write the page with you (pages-live-document.md §3.2): pick who, say what, and it
 * starts in a conversation of its own linked to the page while you stay on the page and watch it write.
 * Opens from the page's button, from a heading's menu, or on a wide screen from the header.
 */
export function PageWriteWith({ agents, chosen, onChoose, target, onSend, onClose }: {
  agents: readonly WriteAgent[];
  chosen: string;
  onChoose: (harness: string) => void;
  target: WriteTarget;
  onSend: (prompt: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const keyboard = useKeyboardInset();
  useEffect(() => listenForOverlayDismissal((event) => {
    const where = event.target instanceof Node ? event.target : null;
    if (where && panel.current?.contains(where)) return;
    onClose();
  }, onClose), [onClose]);
  const send = (prompt: string) => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setProblem(null);
    void onSend(prompt.trim()).then(onClose, (cause: Error) => { setProblem(cause.message); setBusy(false); });
  };
  const starts = target.section
    ? [{ label: "Write this section", prompt: `Write the ${target.section} section.` }]
    : [{ label: "Keep writing", prompt: "Read the page and keep writing it: fill in what is missing, in its own voice." },
      { label: "Tidy it up", prompt: "Tighten the wording and fix mistakes, without changing what it says." }];

  return createPortal(
    <div ref={panel} className="xmatrix-app page-write-with fixed inset-x-3 z-[var(--z-popover)] mx-auto max-w-lg"
      style={{ bottom: `calc(${keyboard}px + env(safe-area-inset-bottom) + 0.75rem)` }}>
      <LiquidGlassCard as="form" aria-label={`Write with ${chosen}`} data-testid="page-write-with"
        className="rounded-[28px] p-3 text-foreground"
        onSubmit={(event) => { event.preventDefault(); send(text); }}>
        <div role="radiogroup" aria-label="Agent" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {agents.map((agent) => {
            const on = agent.harness === chosen;
            return (
              <button key={agent.harness} type="button" role="radio" aria-checked={on} onClick={() => onChoose(agent.harness)}
                className={cn("flex h-9 shrink-0 items-center gap-1.5 rounded-full border-[1px] pl-1 pr-3 text-sm",
                  on ? "border-foreground/45 bg-foreground/[0.06] font-semibold" : "border-foreground/10 text-muted-foreground")}>
                <IdentityAvatar kind="agent" label={agent.harness} imageUrl={agent.avatarUrl} size="sm" shape="circle"
                  glass={false} className="pointer-events-none size-7 rounded-full" />
                {agent.harness}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex items-end gap-2">
          <div className="page-write-field flex min-w-0 flex-1">
            <textarea autoFocus rows={1} value={text} onChange={(event) => setText(event.target.value)}
              aria-label={`What should ${chosen} write?`}
              placeholder={target.section ? `What should ${chosen} write in ${target.section}?` : `What should ${chosen} write?`}
              onKeyDown={(event) => {
                if (isImeKeyDown(event.nativeEvent)) return;
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(text); }
              }}
              className="max-h-32 min-h-11 min-w-0 flex-1 resize-none px-4 py-2.5 text-[16px] leading-6 [field-sizing:content] focus:outline-none" />
          </div>
          <button type="submit" aria-label="Send" disabled={!text.trim() || busy}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-foreground text-background disabled:opacity-30">
            <ArrowUp className="size-5" />
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {starts.map((start) => (
            <button key={start.label} type="button" disabled={busy} onClick={() => send(start.prompt)}
              className="h-9 rounded-full border-[1px] border-foreground/10 px-3.5 text-sm font-medium disabled:opacity-40">
              {start.label}
            </button>
          ))}
        </div>
        {problem && <p role="alert" className="mt-2 px-1 text-sm text-destructive">{problem}</p>}
      </LiquidGlassCard>
    </div>,
    document.body,
  );
}
