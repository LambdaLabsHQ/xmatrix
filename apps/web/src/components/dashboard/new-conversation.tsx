"use client";

import { useCallback, useRef, useState } from "react";
import { Lock, LockOpen, X } from "lucide-react";
import type { ChannelAttachment, SerializedChannel, SerializedSpace, SerializedWorkspace } from "@xmatrix/protocol";
import type { MentionLocalContext } from "./mention-complete";
import type { ComposerSendSnapshot } from "./workspace-shell-message-model";
import { Composer, ComposerIcon } from "./workspace-composer-dialogs";
import { useAndroidBackDismiss } from "./use-android-back";

/**
 * A new conversation is an empty conversation with the usual composer. Its
 * first message creates it (its files upload as they arrive, as anywhere:
 * the message that carries them decides who can see them), Jev routes that message as usual, and xMatrix
 * names and summarises the conversation from what it is about.
 */
export function NewConversation({
  space, token, workspaces, localContext, autoFocus, onCreate, onSend, onCancel, onOpenAppsForSpace,
}: {
  space: SerializedSpace | null;
  token: string | null;
  workspaces: SerializedWorkspace[];
  localContext: MentionLocalContext | null;
  /** False on a phone: a preventScroll focus opens the keyboard over the composer. */
  autoFocus: boolean;
  onCreate: (body: string, mode: "open" | "closed") => Promise<SerializedChannel>;
  onSend: (channel: SerializedChannel, snapshot: ComposerSendSnapshot) => Promise<void>;
  onCancel: () => void;
  onOpenAppsForSpace: (spaceId: string) => void;
}) {
  const draftRef = useRef("");
  const [attachments, setAttachments] = useState<ChannelAttachment[]>([]);
  const [workspaceTarget, setWorkspaceTarget] = useState<string | null>(null);
  const [mode, setMode] = useState<"open" | "closed">("open");
  const [sending, setSending] = useState(false);
  // Created once, by the first send, so a retry after a failed send never
  // creates a second conversation.
  const created = useRef<Promise<SerializedChannel> | null>(null);
  const [locked, setLocked] = useState(false);
  useAndroidBackDismiss(true, onCancel, sending);

  const conversation = useCallback(() => {
    if (!created.current) {
      setLocked(true);
      created.current = onCreate(draftRef.current, mode).catch((error: unknown) => {
        created.current = null;
        setLocked(false);
        throw error;
      });
    }
    return created.current;
  }, [mode, onCreate]);

  return (
    <section className="app-message-surface relative flex min-w-0 flex-1 flex-col overflow-hidden" data-testid="new-conversation">
      <div className="app-panel-header flex shrink-0 items-center justify-between gap-3 bg-card px-4 py-2">
        <div className="min-w-0 text-[18px] font-black leading-none">New conversation</div>
        <button type="button" title="Close" aria-label="Close" onClick={onCancel} disabled={sending}
          className="flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1" />
      <Composer
        channel={null}
        draftIdentity="new-conversation"
        instanceTargetScope="none"
        startsConversation
        space={space}
        token={token}
        workspaces={workspaces}
        localContext={localContext}
        isJoined
        draft=""
        draftSeedRevision={0}
        selectedWorkspaceId={workspaceTarget}
        replyTarget={null}
        attachments={attachments}
        mentionInsertRequest={null}
        autoFocusRequest={autoFocus ? 1 : 0}
        sending={sending}
        error={null}
        placeholder="What should happen?"
        ariaLabel="What should happen"
        sendTitle="Start conversation"
        onDraftChange={(value) => { draftRef.current = value; }}
        onWorkspaceSelect={setWorkspaceTarget}
        onCancelReply={() => {}}
        onAttachmentsChange={setAttachments}
        onOpenAppsForSpace={onOpenAppsForSpace}
        onEscape={onCancel}
        onSend={async (snapshot) => {
          draftRef.current = snapshot.body;
          setSending(true);
          // A failure throws back into the composer, which keeps the draft and says why.
          try {
            await onSend(await conversation(), snapshot);
          } finally {
            setSending(false);
          }
        }}
        inlineActions={
          <ComposerIcon
            label={mode === "closed"
              ? "Closed: only people you add can see it"
              : "Open: everyone in the Space can see it"}
            icon={mode === "closed" ? Lock : LockOpen}
            disabled={locked || sending}
            onClick={() => setMode(mode === "closed" ? "open" : "closed")}
          />
        }
      />
    </section>
  );
}
