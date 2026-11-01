"use client";

import { useRef } from "react";
import type { ComposerField } from "@/components/dashboard/composer-editor";
import { ComposerInputAuthority } from "@/components/dashboard/composer-input";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { WorkingLine } from "./page-margin";
import type { MarginAgent } from "./page-margin-model";

/**
 * What *Comment* on a selected passage opens (pages-live-document.md §4.2): the product's own message box on a card
 * of paper, beside the passage in the margin (under it where the page has no margin), the caret already in it, so
 * it reads at once as somewhere to write. Typing is the comment; Enter or Send sends it with the selected
 * passage. The Agent at work on the page takes it, its Instance card under the box as under a conversation's
 * composer, unless the comment mentions whom it is for. It continues that Agent's conversation, or the passage's
 * editing conversation; with neither there, xMatrix gives it to one in a new discussion. Leaving it, by a click
 * anywhere else, closes it as Escape does; what was typed
 * comes back if the same passage is commented on again.
 */
export function PageCommentBox({ text, taker, onText, onSend, onClose }: {
  /** What is typed so far; it stays with the passage's draft, not with the box. */
  text: string;
  /** The Agent at work on the page that takes the comment, when there is one. */
  taker?: MarginAgent;
  onText: (text: string) => void;
  onSend: (text: string) => void;
  /** `away`: the reader left it for somewhere else, which keeps the focus it went to. */
  onClose: (away?: boolean) => void;
}) {
  const field = useRef<ComposerField | null>(null);
  return (
    <PaperPopover className="page-comment-box py-1 pr-1.5 pl-3" data-testid="page-comment-box" onMouseDown={(event) => {
      event.stopPropagation();
      // Its buttons act without taking the focus from the text, which would close it first.
      if (!(event.target instanceof Node && field.current?.element.contains(event.target))) event.preventDefault();
    }}>
      <ComposerInputAuthority draft={text} onDraftChange={onText} channel={null} space={null} token={null}
        workspaces={[]} enabled autoFocus fieldRef={field} canSend={Boolean(text.trim())}
        placeholder="Comment, or ask for a change" ariaLabel="Comment" sendTitle="Comment"
        onSend={() => { if (text.trim()) onSend(text.trim()); else onClose(); }} onEscape={() => onClose()}
        onFieldBlur={() => onClose(true)} />
      {taker && <WorkingLine agents={[taker]} className="pb-1.5" />}
    </PaperPopover>
  );
}
