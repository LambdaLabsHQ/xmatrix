"use client";

import { Plus } from "lucide-react";
import type { FaceOf } from "@xmatrix/protocol";
import { Face } from "@/components/dashboard/face";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";

/** An Agent as the page's button shows it: its face and name. */
export interface DockAgent { name: string; face: FaceOf }

/**
 * The bottom right of a page on a phone, under the thumb and on the edge where Agents on the page show:
 * the face of the Agent the reader writes with, on its own glass disc. A tap calls it. Once called it
 * says it is starting, until it is on the page and shows beside the line it writes instead.
 */
export function PagePhoneDock({ caller, starting, onCall }: {
  /** The Agent the button calls, or the one just called while its Run starts; null once one is on the page. */
  caller: DockAgent | null;
  starting: boolean;
  onCall: () => void;
}) {
  return (
    <div className="pointer-events-none absolute bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] right-4 z-[var(--z-raised)] flex"
      data-testid="page-phone-dock">
      {caller && (
        <div className="relative flex shrink-0 flex-col items-end">
          {starting && (
            <LiquidGlassPill as="span" role="status"
              className="pointer-events-auto absolute bottom-full right-0 mb-2.5 flex h-9 items-center gap-2 whitespace-nowrap rounded-full px-3 text-[13px] font-medium">
              <span className="page-writer-dots" aria-hidden="true"><i /><i /><i /></span>
              {caller.name} is starting
            </LiquidGlassPill>
          )}
          <button type="button" onClick={onCall} className="page-agent-button pointer-events-auto relative rounded-full"
            aria-label={starting ? `${caller.name} is starting` : `Write with ${caller.name}`}>
            <Face of={caller.face} title={`Write with ${caller.name}`} size="lg" shape="circle"
              className="pointer-events-none rounded-full" />
            {!starting && (
              <span className="page-agent-button-add" aria-hidden="true"><Plus className="size-3" strokeWidth={3} /></span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
