"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { FaceOf } from "@xmatrix/protocol";
import { Face } from "@/components/dashboard/face";
import { listenForOverlayDismissal } from "@/components/dashboard/use-overlay-dismiss";
import { actionClass } from "@/components/ui/action-tone";
import { LiquidGlassCard } from "@/components/ui/material-surfaces";

/** An Agent the reader can co-write the page with: a runtime of the Space, whose face is its vendor's. */
export interface WriteAgent { harness: string }

/** An Agent already on the page: who, its face, and what it is doing. */
export interface WritingAgent { name: string; face: FaceOf; doing: string }

/**
 * Co-writing a page with an Agent (pages-live-document.md §3.2). The reader types only in the page:
 * starting is one tap on the face of the Agent to write with, and the Agent infers the rest from the
 * page. Tapping an Agent already on the page shows what it is doing, and the conversation it works from.
 */
export function PageWriteWith({ agents, working, onStart, onOpenConversation, onStop, onUndo, onClose, switchTo }: {
  agents: readonly WriteAgent[];
  /** The Agent tapped on the page, or null to choose one to start with. */
  working: WritingAgent | null;
  onStart: (harness: string) => void;
  onOpenConversation: (() => void) | null;
  /** Ends its co-writing: it leaves the page. */
  onStop?: (() => void) | null;
  /** Takes back its last change, while nobody has changed it since. */
  onUndo?: (() => void) | null;
  onClose: () => void;
  /** It went quiet: another Agent writes instead. */
  switchTo?: { label: string; run: () => void };
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => listenForOverlayDismissal((event) => {
    const where = event.target instanceof Node ? event.target : null;
    if (where && panel.current?.contains(where)) return;
    onClose();
  }, onClose), [onClose]);

  return createPortal(
    <div ref={panel} className="xmatrix-app page-write-with fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-[var(--z-popover)] mx-auto max-w-lg">
      <LiquidGlassCard aria-label={working ? working.name : "Co-write with"} data-testid="page-write-with"
        className="rounded-[28px] px-3 pb-3 pt-2.5 text-foreground">
        {working ? (
          <div className="flex items-center gap-3">
            <Face of={working.face} size="md" shape="circle" glass={false} className="pointer-events-none rounded-full" />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[15px] font-semibold">{working.name}</p>
              <p className="truncate text-[13px] text-muted-foreground">{working.doing}</p>
            </div>
            {onOpenConversation && (
              <button type="button" onClick={onOpenConversation} className={actionClass({ variant: "secondary", size: "md" })}>
                Conversation
              </button>
            )}
            {onUndo && (
              <button type="button" onClick={onUndo} className={actionClass({ variant: "secondary", size: "md" })}>
                Undo
              </button>
            )}
            {onStop && (
              <button type="button" onClick={onStop} className={actionClass({ variant: "secondary", size: "md" })}>
                Stop
              </button>
            )}

          </div>
        ) : null}
        {working && switchTo && (
          <button type="button" onClick={switchTo.run}
            className={actionClass({ variant: "primary", size: "md" }, "mt-2.5 w-full justify-center")}>
            {switchTo.label}
          </button>
        )}
        {working ? null : (
          <>
            <p className="px-1 pb-2 text-[13px] font-medium text-muted-foreground">Co-write with</p>
            <div className="flex gap-2 overflow-x-auto">
              {agents.map((agent) => (
                <button key={agent.harness} type="button" onClick={() => onStart(agent.harness)}
                  className="flex w-[4.5rem] shrink-0 flex-col items-center gap-1.5 rounded-[20px] py-1.5 active:bg-foreground/[0.06]">
                  <Face of={{ kind: "agent", name: agent.harness, harness: agent.harness }} size="lg" shape="circle"
                    glass={false} className="pointer-events-none rounded-full" />
                  <span className="max-w-full truncate text-[13px] font-medium">{agent.harness}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </LiquidGlassCard>
    </div>,
    document.body,
  );
}
