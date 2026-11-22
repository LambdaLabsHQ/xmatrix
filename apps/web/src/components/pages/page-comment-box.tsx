"use client";

import { useRef } from "react";
import type { AgentInvocationSelection, SerializedSpace, SerializedWorkspace } from "@xmatrix/protocol";
import type { ComposerField } from "@/components/dashboard/composer-editor";
import { ComposerInputAuthority } from "@/components/dashboard/composer-input";
import {
  composerSendDraft, selectComposerInvocation, selectComposerReference, updateComposerInvocationDraft,
  isAgentBinding, type ComposerInvocationDraft,
} from "@/components/dashboard/composer-invocation-bindings";
import type { MentionLocalContext } from "@/components/dashboard/mention-complete";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { WorkingLine } from "./page-margin";
import type { MarginAgent } from "./page-margin-model";

/** What a conversation's composer completes from, so `@`, `#` and `/` here offer what they offer there. */
export interface PageCommentComposerContext {
  space: SerializedSpace | null;
  token: string | null;
  workspaces: SerializedWorkspace[];
  localContext: MentionLocalContext | null;
  onOpenAppsForSpace?: (spaceId: string) => void;
  onEditHarnessProfile?: (harness: string) => void;
}

/** A comment as sent: its text, with the Agents picked from its `@` list measured against that text. */
export interface PageCommentText { body: string; selections: AgentInvocationSelection[] }

/**
 * What *Comment* on a selected passage opens (pages-live-document.md §4.2): the product's own message box on a card
 * of paper, beside the passage in the margin (under it where the page has no margin), the caret already in it, so
 * it reads at once as somewhere to write. Typing is the comment; Enter or Send sends it with the selected
 * passage. The Agent at work on the page takes it, its Instance card under the box as under a conversation's
 * composer, unless the comment mentions whom it is for. It completes as a new conversation's composer does: `@`
 * lists every Agent the Space can start and the launch conditions, and a picked one starts in a new discussion.
 * It continues that Agent's conversation, or the passage's editing conversation; with neither there, xMatrix gives
 * it to one in a new discussion. Leaving it, by a click anywhere else, closes it as Escape does; what was typed
 * comes back if the same passage is commented on again.
 */
export function PageCommentBox({ text, taker, context, onText, onSend, onClose }: {
  /** What is typed so far; it stays with the passage's draft, not with the box. */
  text: string;
  /** The Agent at work on the page that takes the comment, when there is one. */
  taker?: MarginAgent;
  /** The Space the page is in; without it the box completes nothing. */
  context?: PageCommentComposerContext;
  onText: (text: string) => void;
  onSend: (comment: PageCommentText) => void;
  /** `away`: the reader left it for somewhere else, which keeps the focus it went to. */
  onClose: (away?: boolean) => void;
}) {
  const field = useRef<ComposerField | null>(null);
  // Picks live with the box: a draft that comes back holds its text, resolved as typed.
  const picks = useRef<ComposerInvocationDraft | undefined>(undefined);
  const change = (next: string) => {
    picks.current = updateComposerInvocationDraft(picks.current, next);
    onText(next);
  };
  const space = context?.space ?? null;
  return (
    <PaperPopover className="page-comment-box py-1" data-testid="page-comment-box" onMouseDown={(event) => {
      event.stopPropagation();
      // Its buttons act without taking the focus from the text, which would close it first.
      if (!(event.target instanceof Node && field.current?.element.contains(event.target))) event.preventDefault();
    }}>
      <ComposerInputAuthority draft={text} onDraftChange={change} channel={null} instanceTargetScope="none"
        space={space} token={context?.token ?? null} workspaces={context?.workspaces ?? []}
        localContext={context?.localContext ?? null}
        onInvocationSelect={(value, selected, label) => {
          picks.current = selectComposerInvocation(picks.current, value, selected, label);
          onText(value);
        }}
        onReferenceSelect={(value, selected) => {
          picks.current = selectComposerReference(picks.current, value, selected);
          onText(value);
        }}
        referenceRanges={picks.current?.body === text
          ? picks.current.bindings.filter((binding) => !isAgentBinding(binding)) : undefined}
        onConfigureAppConnector={() => { if (space) context?.onOpenAppsForSpace?.(space.id); }}
        onEditHarnessProfile={context?.onEditHarnessProfile}
        enabled autoFocus fieldRef={field} canSend={Boolean(text.trim())}
        placeholder="Comment, or ask for a change" ariaLabel="Comment" sendTitle="Comment"
        onSend={() => {
          const typed = text.trim();
          if (!typed) return onClose();
          onSend(composerSendDraft(picks.current, typed));
        }} onEscape={() => onClose()}
        onFieldBlur={() => onClose(true)} />
      {taker && <WorkingLine agents={[taker]} className="pb-1.5 pl-3" />}
    </PaperPopover>
  );
}
