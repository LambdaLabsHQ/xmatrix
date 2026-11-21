import {
  updateComposerInvocationDraft,
  type ComposerInvocationBinding,
  type ComposerInvocationDraft,
} from "./composer-invocation-bindings";
/**
 * Session-scoped per-channel composer draft helpers.
 * Keeps input text, workspace selection, and attachments isolated by channel id,
 * and mirrors text/selection drafts into sessionStorage so reloads do not drop
 * unsent text.
 */

const COMPOSER_DRAFTS_STORAGE_PREFIX = "xmatrix:composer-drafts:v1:";
const MAX_PERSISTED_DRAFTS = 20;
const MAX_PERSISTED_DRAFTS_BYTES = 64 * 1024;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ChannelComposerDraft<TAttachment = unknown> = {
  text: string;
  invocationDraft?: ComposerInvocationDraft;
  workspaceTarget: string | null;
  attachments: TAttachment[];
};

type PersistedChannelComposerDraft = {
  text: string;
  invocationDraft?: ComposerInvocationDraft;
  workspaceTarget: string | null;
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
  // Delete and re-insert so Map iteration order tracks recency for bounded persistence.
  store.delete(channelId);
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

export function hasChannelComposerAttachments<TAttachment>(
  store: ReadonlyMap<string, ChannelComposerDraft<TAttachment>>
): boolean {
  for (const draft of store.values()) {
    if (draft.attachments.length > 0) return true;
  }
  return false;
}

function resolveDraftStorage(
  userId: string | null | undefined,
  storage?: StorageLike | null
): { key: string; target: StorageLike } | null {
  if (!userId) return null;
  let target: StorageLike | null = storage ?? null;
  if (storage === undefined) {
    try {
      target = typeof window === "undefined" ? null : window.sessionStorage;
    } catch {
      return null;
    }
  }
  return target ? { key: `${COMPOSER_DRAFTS_STORAGE_PREFIX}${userId}`, target } : null;
}

function isValidInvocationBinding(value: unknown): value is ComposerInvocationBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.start) ||
    !Number.isSafeInteger(candidate.end) ||
    (candidate.start as number) < 0 ||
    (candidate.end as number) < (candidate.start as number) ||
    typeof candidate.text !== "string"
  ) {
    return false;
  }
  if ("reference" in candidate) return typeof candidate.reference === "string";
  return "target" in candidate && Boolean(candidate.target) && typeof candidate.target === "object";
}

function parsePersistedInvocationDraft(value: unknown, text: string): ComposerInvocationDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { body?: unknown; bindings?: unknown };
  if (typeof candidate.body !== "string" || !Array.isArray(candidate.bindings)) return undefined;
  const bindings = candidate.bindings.filter(isValidInvocationBinding);
  if (bindings.length === 0) return undefined;
  const normalized = updateComposerInvocationDraft({ body: candidate.body, bindings }, text);
  return normalized.bindings.length > 0 ? normalized : undefined;
}

/**
 * Loads session-saved text drafts for this account into `store` without
 * overwriting drafts already edited in memory.
 */
export function hydrateChannelComposerDrafts<TAttachment>(
  store: Map<string, ChannelComposerDraft<TAttachment>>,
  userId: string | null | undefined,
  storage?: StorageLike | null
): number {
  const resolved = resolveDraftStorage(userId, storage);
  if (!resolved) return 0;
  let raw: string | null;
  try {
    raw = resolved.target.getItem(resolved.key);
  } catch {
    return 0;
  }
  if (!raw) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  let restoredCount = 0;
  for (const [channelId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!channelId || store.has(channelId) || !entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const text = typeof candidate.text === "string" ? candidate.text : "";
    const workspaceTarget = typeof candidate.workspaceTarget === "string" ? candidate.workspaceTarget : null;
    if (text.length === 0 && workspaceTarget === null) continue;
    const invocationDraft = parsePersistedInvocationDraft(candidate.invocationDraft, text);
    store.set(channelId, {
      text,
      ...(invocationDraft ? { invocationDraft } : {}),
      workspaceTarget,
      attachments: [],
    });
    restoredCount += 1;
    if (restoredCount >= MAX_PERSISTED_DRAFTS) break;
  }
  return restoredCount;
}

/**
 * Writes the most recent serializable channel drafts (text, invocation picks,
 * workspace target) to sessionStorage under a strict entry and byte cap.
 */
export function persistChannelComposerDrafts<TAttachment>(
  store: ReadonlyMap<string, ChannelComposerDraft<TAttachment>>,
  userId: string | null | undefined,
  storage?: StorageLike | null
): void {
  const resolved = resolveDraftStorage(userId, storage);
  if (!resolved) return;
  const serializable: [string, PersistedChannelComposerDraft][] = [];
  for (const [channelId, draft] of store.entries()) {
    if (draft.text.length === 0 && draft.workspaceTarget === null) continue;
    serializable.push([
      channelId,
      {
        text: draft.text,
        ...(draft.invocationDraft?.bindings.length ? { invocationDraft: draft.invocationDraft } : {}),
        workspaceTarget: draft.workspaceTarget,
      },
    ]);
  }
  const recent = serializable.slice(-MAX_PERSISTED_DRAFTS);
  try {
    if (recent.length === 0) {
      resolved.target.removeItem(resolved.key);
      return;
    }
    // Trim oldest entries until the serialized payload stays inside the byte budget.
    for (let start = 0; start < recent.length; start += 1) {
      const serialized = JSON.stringify(Object.fromEntries(recent.slice(start)));
      if (serialized.length <= MAX_PERSISTED_DRAFTS_BYTES) {
        resolved.target.setItem(resolved.key, serialized);
        return;
      }
    }
    resolved.target.removeItem(resolved.key);
  } catch {
    // Private browsing or quota limits must never interrupt typing.
  }
}

export function clearPersistedChannelComposerDrafts(
  userId: string | null | undefined,
  storage?: StorageLike | null
): void {
  persistChannelComposerDrafts(new Map(), userId, storage);
}
