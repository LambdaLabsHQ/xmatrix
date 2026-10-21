"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { avatarInitials } from "@/components/dashboard/completion-option-button";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { PaperPopover } from "@/components/ui/material-surfaces";
import type { WriteAgent } from "./page-write-with";

/**
 * What the passage a reader selected opens (pages-live-document.md §4.2): a box under it, the caret already
 * in it, addressed to an Agent. Typing is the comment; Enter sends it as a discussion of the passage, which
 * the Agent answers there and in the page. Until something is typed, the keys that act on a selection
 * (Backspace, copy, cut) still act on the passage.
 */
export function PageCommentBox({ agents, to, text, onText, onTo, onSend, onClose, onPassageKey }: {
  agents: readonly WriteAgent[];
  /** The Agent the comment is said to. */
  to: string;
  /** What is typed so far; it stays with the passage's draft, not with the box. */
  text: string;
  onText: (text: string) => void;
  onTo: (harness: string) => void;
  onSend: (text: string) => void;
  onClose: () => void;
  /** A key for the passage itself, pressed while nothing is typed; true when the passage took it. */
  onPassageKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}) {
  const field = useRef<HTMLTextAreaElement | null>(null);
  const [choosing, setChoosing] = useState(false);
  const agent = agents.find((entry) => entry.harness === to);
  useEffect(() => { field.current?.focus(); }, []);
  // As tall as what it says.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (text.trim()) onSend(text.trim());
      else onClose();
      return;
    }
    if (!text && onPassageKey(event)) event.preventDefault();
  };

  return (
    <PaperPopover role="dialog" aria-label={`Comment to ${to}`} data-testid="page-comment-box"
      className="page-comment-box flex items-start gap-2 px-2.5 py-2"
      onMouseDown={(event) => event.stopPropagation()}>
      <div className="relative shrink-0">
        <button type="button" className="page-comment-to" title={`To ${to}; choose who`} aria-label={`To ${to}`}
          aria-expanded={choosing} onMouseDown={(event) => event.preventDefault()}
          onClick={() => setChoosing((open) => !open)}>
          <IdentityAvatar kind="agent" label={to} imageUrl={agent?.avatarUrl} size="xs" shape="circle" glass={false}
            initials={agent?.avatarUrl ? avatarInitials(to) : undefined} className="pointer-events-none rounded-full" />
        </button>
        {choosing && (
          <PaperPopover role="listbox" aria-label="Say it to" className="absolute left-0 top-7 z-10 w-44 p-1">
            {agents.map((entry) => (
              <button key={entry.harness} type="button" role="option" aria-selected={entry.harness === to}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { onTo(entry.harness); setChoosing(false); field.current?.focus(); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm">
                <IdentityAvatar kind="agent" label={entry.harness} imageUrl={entry.avatarUrl} size="xs" shape="circle"
                  glass={false} initials={entry.avatarUrl ? avatarInitials(entry.harness) : undefined}
                  className="pointer-events-none rounded-full" />
                <span className="min-w-0 flex-1 truncate">{entry.harness}</span>
              </button>
            ))}
          </PaperPopover>
        )}
      </div>
      <textarea ref={field} rows={1} value={text} aria-label="Comment"
        placeholder={`Comment, or ask ${to} to change it`}
        onChange={(event) => onText(event.target.value)} onKeyDown={keyDown}
        // Leaving it with nothing said closes it; what was typed stays until it is sent or dismissed.
        onBlur={(event) => {
          if (!text.trim() && !event.currentTarget.closest("[data-testid='page-comment-box']")
            ?.contains(event.relatedTarget as Node | null)) onClose();
        }}
        className="page-comment-text min-w-0 flex-1 resize-none bg-transparent focus:outline-none" />
    </PaperPopover>
  );
}
