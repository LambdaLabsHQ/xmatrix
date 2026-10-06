"use client";

import { createRoot } from "react-dom/client";
import { avatarInitials } from "@/components/dashboard/completion-option-button";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { COUNT_CHIP_MATERIAL_CLASS } from "@/components/dashboard/workspace-shell-constants";
import { cn } from "@/lib/utils";

/** An Agent live in a conversation about a section, whether or not it has the page open. */
export interface SectionAgent {
  name: string;
  busy: boolean;
  avatarUrl?: string;
  conversation: { id: string; name: string | null };
}

const SHOWN = 3;

/**
 * The Agents on a section's heading, drawn as the page tree draws a page's:
 * their own avatars, busy ones first, three at most and the rest as a count.
 * An idle one is dimmed; a click opens the conversation it works in.
 */
function SectionAgents({ agents, openConversation }: { agents: readonly SectionAgent[];
  openConversation: (conversationId: string) => void }) {
  const sorted = [...agents].sort((a, b) => Number(b.busy) - Number(a.busy));
  const hidden = sorted.length - SHOWN;
  return (
    <>
      {sorted.slice(0, SHOWN).map((agent) => {
        const label = `${agent.name} · ${agent.busy ? "Working" : "Idle"}${agent.conversation.name
          ? ` · in ${agent.conversation.name}` : ""}`;
        return (
          <IdentityAvatar key={`${agent.conversation.id}:${agent.name}`} kind="agent" label={agent.name} title={label}
            imageUrl={agent.avatarUrl} initials={agent.avatarUrl ? avatarInitials(agent.name) : undefined}
            size="xs" shape="circle" onClick={() => openConversation(agent.conversation.id)}
            className={cn("page-section-working rounded-full", agent.busy && "is-busy")} />
        );
      })}
      {hidden > 0 && (
        <span className={cn("inline-flex h-5 min-w-5 items-center justify-center px-1 text-[10px] font-bold",
          COUNT_CHIP_MATERIAL_CLASS)} title={sorted.slice(SHOWN).map((agent) => agent.name).join(", ")}>
          +{hidden}
        </span>
      )}
    </>
  );
}

/** Draws the stack into a heading's widget, which is plain DOM; the returned function takes it down. */
export function mountSectionAgents(element: HTMLElement, agents: readonly SectionAgent[],
  openConversation: (conversationId: string) => void): () => void {
  const root = createRoot(element);
  root.render(<SectionAgents agents={agents} openConversation={openConversation} />);
  // The editor drops a widget while React may be rendering; unmount after it.
  return () => queueMicrotask(() => root.unmount());
}
