"use client";

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { CommentIcon } from "./page-margin";

/**
 * What the passage a reader selected opens (pages-live-document.md §4.2): a box under it, the caret already
 * in it. Typing is the comment; Enter sends it as a discussion of the passage. It names nobody: the Agent at
 * work there takes it, else xMatrix gives it to one, unless the comment mentions whom it is for. Until something
 * is typed, the keys that act on a selection (Backspace, copy, cut, marks) still act on the passage.
 */
export function PageCommentBox({ text, onText, onSend, onClose, onPassageKey }: {
  /** What is typed so far; it stays with the passage's draft, not with the box. */
  text: string;
  onText: (text: string) => void;
  onSend: (text: string) => void;
  onClose: () => void;
  /** A key for the passage itself, pressed while nothing is typed; true when the passage took it. */
  onPassageKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}) {
  const field = useRef<HTMLTextAreaElement | null>(null);
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
    <PaperPopover role="dialog" aria-label="Comment" data-testid="page-comment-box"
      className="page-comment-box flex items-start gap-2 px-3 py-2"
      onMouseDown={(event) => event.stopPropagation()}>
      <span className="page-comment-mark"><CommentIcon /></span>
      <textarea ref={field} rows={1} value={text} aria-label="Comment" placeholder="Comment, or ask for a change"
        onChange={(event) => onText(event.target.value)} onKeyDown={keyDown}
        // Leaving it with nothing said closes it; what was typed stays until it is sent or dismissed.
        onBlur={() => { if (!text.trim()) onClose(); }}
        className="page-comment-text min-w-0 flex-1 resize-none bg-transparent focus:outline-none" />
    </PaperPopover>
  );
}
