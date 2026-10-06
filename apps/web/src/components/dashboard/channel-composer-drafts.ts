import { updateComposerInvocationDraft, type ComposerInvocationDraft } from "./composer-invocation-bindings";
/**
 * Session-scoped per-channel composer draft helpers.
 * Keeps input text, workspace selection, and attachments isolated by channel id.
 */

export type ChannelComposerDraft<TAttachment = unknown> = {
  text: string;
  invocationDraft?: ComposerInvocationDraft;
  workspaceTarget: string | null;
  attachments: TAttachment[];
};

export function emptyChannelComposerDraft<TAttachment = unknown>(): ChannelComposerDraft<TAttachment> {
  return {
    text: "",
    workspaceTarget: null,
    attachments: [],
  };
}

export function isChannelComposerDraftEmpty<TAttachment>(
  draft: ChannelComposerDraft<TAttachment>
): boolean {
  return draft.text.length === 0 && draft.workspaceTarget === null && draft.attachments.length === 0;
}

export function readChannelComposerDraft<TAttachment>(
  store: ReadonlyMap<string, ChannelComposerDraft<TAttachment>>,
  channelId: string | null | undefined
): ChannelComposerDraft<TAttachment> {
  if (!channelId) return emptyChannelComposerDraft();
  const saved = store.get(channelId);
  if (!saved) return emptyChannelComposerDraft();
  return {
    text: saved.text,
    ...(saved.invocationDraft ? { invocationDraft: structuredClone(saved.invocationDraft) } : {}),
    workspaceTarget: saved.workspaceTarget,
    attachments: saved.attachments.slice(),
  };
}

export function writeChannelComposerDraft<TAttachment>(
  store: Map<string, ChannelComposerDraft<TAttachment>>,
  channelId: string | null | undefined,
  draft: ChannelComposerDraft<TAttachment>
): void {
  if (!channelId) return;
  if (isChannelComposerDraftEmpty(draft)) {
    store.delete(channelId);
    return;
  }
  const invocationDraft = updateComposerInvocationDraft(draft.invocationDraft ?? store.get(channelId)?.invocationDraft, draft.text);
  store.set(channelId, {
    text: draft.text,
    ...(invocationDraft.bindings.length ? { invocationDraft } : {}),
    workspaceTarget: draft.workspaceTarget,
    attachments: draft.attachments.slice(),
  });
}

export function clearChannelComposerDraft<TAttachment>(
  store: Map<string, ChannelComposerDraft<TAttachment>>,
  channelId: string | null | undefined
): void {
  if (!channelId) return;
  store.delete(channelId);
}
