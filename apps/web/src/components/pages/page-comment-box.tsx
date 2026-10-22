"use client";

import { useRef, type KeyboardEvent } from "react";
import { ComposerInputAuthority } from "@/components/dashboard/composer-input";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { WorkingLine } from "./page-margin";
import type { MarginAgent } from "./page-margin-model";

/**
 * What the passage a reader selected opens (pages-live-document.md §4.2): the product's own message box on a card
 * of paper, beside the passage in the margin (under it where the page has no margin), the caret already in it, so
 * it reads at once as somewhere to write. Typing is the comment; Enter or Send sends it as a discussion of the
 * passage. The Agent at work on the page takes it, its Instance card under the box as under a conversation's
 * composer, unless the comment mentions whom it is for; with none there, xMatrix gives it to one. Until something
 * is typed, the keys that act on a selection (Backspace, copy, cut, marks) still act on the passage. Leaving it, by a click anywhere else, closes it as Escape does; what was typed
 * comes back if the same passage is commented on again.
 */
export function PageCommentBox({ text, taker, onText, onSend, onClose, onPassageKey }: {
  /** What is typed so far; it stays with the passage's draft, not with the box. */
  text: string;
  /** The Agent at work on the page that takes the comment, when there is one. */
  taker?: MarginAgent;
  onText: (text: string) => void;
  onSend: (text: string) => void;
  /** `away`: the reader left it for somewhere else, which keeps the focus it went to. */
  onClose: (away?: boolean) => void;
  /** A key for the passage itself, pressed while nothing is typed; true when the passage took it. */
  onPassageKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}) {
  const field = useRef<HTMLTextAreaElement | null>(null);
  return (
    <PaperPopover className="page-comment-box py-1 pr-1.5 pl-3" data-testid="page-comment-box" onMouseDown={(event) => {
      event.stopPropagation();
      // Its buttons act without taking the focus from the text, which would close it first.
      if (event.target !== field.current) event.preventDefault();
    }}>
      <ComposerInputAuthority draft={text} onDraftChange={onText} channel={null} space={null} token={null}
        workspaces={[]} enabled autoFocus textareaRef={field} canSend={Boolean(text.trim())}
        placeholder="Comment, or ask for a change" ariaLabel="Comment" sendTitle="Comment"
        onSend={() => { if (text.trim()) onSend(text.trim()); else onClose(); }} onEscape={() => onClose()}
        onKeyDownExtra={(event) => { if (!text && onPassageKey(event)) event.preventDefault(); }}
        onTextareaBlur={() => onClose(true)} />
      {taker && <WorkingLine agents={[taker]} className="pb-1.5" />}
    </PaperPopover>
  );
}
