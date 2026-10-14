"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { avatarInitials } from "@/components/dashboard/completion-option-button";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";

/** An Agent as the page's button shows it: its face and name. */
export interface DockAgent { name: string; avatarUrl?: string }

/** The Agent on the page, or the one just called while its Run starts. */
export interface DockWriter {
  agent: DockAgent;
  /** Called, and its Run is still starting. */
  starting?: boolean;
}

/**
 * The bottom of a page on a phone, under the thumb: what changed since the reader last read it on the
 * left, and on the right the Agent they write with, a wood button like the app's other floating button.
 * Before an Agent is on the page the button carries the face of the one they would call; once one is,
 * it is that Agent's face, and a tap opens the conversation it works from.
 */
export function PagePhoneDock({ review, writer, caller, onCall, onTalk }: {
  review: ReactNode;
  writer: DockWriter | null;
  /** The Agent the button calls when none is on the page. */
  caller: DockAgent | null;
  onCall: () => void;
  /** Opens the conversation the Agent on the page works from. */
  onTalk: () => void;
}) {
  const agent = writer?.agent ?? caller;
  if (!review && !agent) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-[var(--z-raised)] flex items-end gap-3 px-4"
      data-testid="page-phone-dock">
      {review ?? <span className="flex-1" />}
      {agent && (
        <div className="relative flex shrink-0 flex-col items-end">
          {writer?.starting && (
            <LiquidGlassPill as="button" type="button" onClick={onTalk}
              className="pointer-events-auto absolute bottom-full right-0 mb-2.5 flex h-9 items-center gap-2 whitespace-nowrap rounded-full px-3 text-[13px] font-medium"
              aria-label={`${writer.agent.name} is starting`}>
              <span className="page-writer-dots" aria-hidden="true"><i /><i /><i /></span>
              <span>Starting</span>
            </LiquidGlassPill>
          )}
          <WoodPanel as="button" type="button" onClick={writer ? onTalk : onCall}
            className="page-agent-button pointer-events-auto relative grid size-14 place-items-center rounded-full"
            aria-label={writer ? `Talk to ${writer.agent.name}` : `Write with ${agent.name}`}
            title={writer ? `Talk to ${writer.agent.name}` : `Write with ${agent.name}`}>
            <IdentityAvatar kind="agent" label={agent.name} imageUrl={agent.avatarUrl}
              initials={agent.avatarUrl ? avatarInitials(agent.name) : undefined} size="md" shape="circle"
              className="pointer-events-none rounded-full" />
            {!writer && (
              <span className="page-agent-button-add" aria-hidden="true"><Plus className="size-3" strokeWidth={3} /></span>
            )}
          </WoodPanel>
        </div>
      )}
    </div>
  );
}
