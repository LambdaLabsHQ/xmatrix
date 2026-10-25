"use client";

import { createPortal } from "react-dom";
import type { FaceOf } from "@xmatrix/protocol";
import { Face } from "@/components/dashboard/face";
import { COUNT_CHIP_MATERIAL_CLASS } from "@/components/dashboard/workspace-shell-constants";
import { cn } from "@/lib/utils";
import { widgetPortals } from "./page-widget-portals";

/** An Agent live in a conversation about a section, whether or not it has the page open. */
export interface SectionAgent {
  name: string;
  busy: boolean;
  face: FaceOf;
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
          <Face key={`${agent.conversation.id}:${agent.name}`} of={agent.face} title={label}
            size="xs" shape="circle" onClick={() => openConversation(agent.conversation.id)}
            className={cn("page-section-working rounded-full", agent.busy && "is-busy")} />
        );
      })}
      {hidden > 0 && (
        <span className={cn("app-overflow-count inline-flex h-5 min-w-5 items-center justify-center px-1 text-[10px] font-bold",
          COUNT_CHIP_MATERIAL_CLASS)} title={sorted.slice(SHOWN).map((agent) => agent.name).join(", ")}>
          +{hidden}
        </span>
      )}
    </>
  );
}

/** The stacks the headings' widgets hold, drawn by `SectionAgentsInPage` from inside the page's own tree. */
const stacks = widgetPortals<{ agents: readonly SectionAgent[]; openConversation: (conversationId: string) => void }>(
  "section-agents");

/** Draws the stack into a heading's widget; the returned function takes it down. */
export function mountSectionAgents(element: HTMLElement, agents: readonly SectionAgent[],
  openConversation: (conversationId: string) => void): () => void {
  return stacks.mount(element, { agents, openConversation });
}

/** Every heading's stack, drawn into its widget from the page's tree. */
export function SectionAgentsInPage() {
  const current = stacks.useDrawn();
  return (
    <>
      {current.map(({ element, key, agents, openConversation }) =>
        createPortal(<SectionAgents agents={agents} openConversation={openConversation} />, element, key))}
    </>
  );
}
