/**
 * Product tail cache: durable bounded-tail channel history validated by the
 * catalog-carried per-channel content watermark.
 *
 * A channel row arriving in a fresh authenticated catalog proves "this user
 * may see this channel right now"; a persisted entry only proves "this
 * machine saved these bytes". An entry becomes renderable only when both
 * agree: the entry's applied `contentRevision` must exactly equal the
 * catalog row's current one. The Hub moves that watermark exactly when the
 * bytes of already-served history can change (edit, recall, redaction,
 * archive drain) and never on append, so under an equal revision the only
 * possible delta is appended sequences — which the caller reconciles with one
 * afterSequence fetch from the entry's tail. A moved revision purges (the
 * bytes are provably stale and no incremental fetch can repair mutated
 * rows); everything unknown, missing, or regressed fails closed. Without a
 * known applied revision nothing is persisted and nothing is shown.
 */

export const PRODUCT_TAIL_CACHE_SCHEMA_VERSION = 2;
export const PRODUCT_TAIL_CACHE_TOTAL_BUDGET_BYTES = 8 * 1024 * 1024;
export const PRODUCT_TAIL_CACHE_CHANNEL_BUDGET_BYTES = 512 * 1024;
export const PRODUCT_TAIL_CACHE_CHANNEL_MESSAGE_LIMIT = 100;

interface TailCacheMessageAttachment {
  [key: string]: unknown;
}

export interface ProductTailCacheMessage {
  messageId: string;
  sequence?: number;
  attachments?: TailCacheMessageAttachment[];
  [key: string]: unknown;
}

export interface ProductTailCacheEntry {
  schemaVersion: number;
  userId: string;
  channelId: string;
  /** Channel contentRevision these bytes were applied under. Admission
   * requires exact equality with the catalog row's current revision. */
  appliedContentRevision: number;
  tailSequence: number;
  hasOlderMessages: boolean;
  messages: ProductTailCacheMessage[];
  verifiedTail: Array<[string, number]>;
  cachedAt: number;
  lastAccessAt: number;
  encodedBytes: number;
}

function safeCount(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

const VOLATILE_ATTACHMENT_KEYS = ["dataUrl", "url", "objectKey", "thumbnailUrl"] as const;

/**
 * Persisted attachments keep only stable record descriptors. Bodies, data
 * URLs, download URLs, and storage locators must never reach disk; media
 * rehydrates through the authenticated lazy retrieval path.
 */
function sanitizeMessageForDisk(message: ProductTailCacheMessage): ProductTailCacheMessage {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) return message;
  return {
    ...message,
    attachments: message.attachments.map((attachment) => {
      const sanitized = { ...attachment };
      for (const key of VOLATILE_ATTACHMENT_KEYS) delete sanitized[key];
      return sanitized;
    }),
  };
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export interface BuildProductTailCacheEntryInput {
  userId: string;
  channelId: string;
  messages: ProductTailCacheMessage[];
  hasOlderMessages: boolean;
  verifiedTail?: ReadonlyMap<string, number>;
  cachedAt: number;
  contentRevision: number;
}

/**
 * Builds the durable entry for one channel, or null when nothing admissible
 * can be persisted. Only server-sequenced rows are kept (pending/optimistic
 * sends have no sequence), bounded to the newest
 * PRODUCT_TAIL_CACHE_CHANNEL_MESSAGE_LIMIT rows and
 * PRODUCT_TAIL_CACHE_CHANNEL_BUDGET_BYTES encoded bytes. Trimming older rows
 * for budget forces hasOlderMessages so a bounded tail is never presented as
 * complete history.
 */
export function buildProductTailCacheEntry(
  input: BuildProductTailCacheEntryInput,
): ProductTailCacheEntry | null {
  if (!safeCount(input.contentRevision)) return null;
  const sequenced = input.messages
    .filter((message) =>
      typeof message.messageId === "string" && message.messageId.length > 0 &&
      safeCount(message.sequence, 1)
    )
    .map(sanitizeMessageForDisk)
    .sort((left, right) => (left.sequence as number) - (right.sequence as number));
  const deduped = sequenced.filter((message, index) =>
    index === 0 || (message.sequence as number) !== (sequenced[index - 1]!.sequence as number)
  );
  let window = deduped.slice(-PRODUCT_TAIL_CACHE_CHANNEL_MESSAGE_LIMIT);
  let trimmedForBudget = window.length < deduped.length;
  while (window.length > 0 && encodedByteLength(window) > PRODUCT_TAIL_CACHE_CHANNEL_BUDGET_BYTES) {
    window = window.slice(1);
    trimmedForBudget = true;
  }
  if (window.length === 0) return null;
  const tailSequence = window[window.length - 1]!.sequence as number;
  const windowIds = new Set(window.map((message) => message.messageId));
  const verifiedTail: Array<[string, number]> = [];
  for (const [messageId, sequence] of input.verifiedTail ?? []) {
    if (windowIds.has(messageId)) verifiedTail.push([messageId, sequence]);
  }
  const entry: ProductTailCacheEntry = {
    schemaVersion: PRODUCT_TAIL_CACHE_SCHEMA_VERSION,
    userId: input.userId,
    channelId: input.channelId,
    appliedContentRevision: input.contentRevision,
    tailSequence,
    hasOlderMessages: input.hasOlderMessages || trimmedForBudget,
    messages: window,
    verifiedTail,
    cachedAt: input.cachedAt,
    lastAccessAt: input.cachedAt,
    encodedBytes: 0,
  };
  entry.encodedBytes = encodedByteLength(entry);
  return entry;
}

export type ProductTailCacheAdmission =
  | { decision: "open"; entry: ProductTailCacheEntry; revalidateAfterSequence: number }
  | { decision: "purge"; reason: string }
  | { decision: "closed"; reason: string };

/** Current catalog facts for one channel. `contentRevision` comes from the
 * catalog row's `contentAuthority`; absent (older Hub, malformed) is no
 * signal and keeps the entry closed rather than opening or destroying it. */
export interface ProductTailCacheChannelBinding {
  channelId: string;
  historyHeadSequence?: number;
  contentRevision?: number;
}

function entryInternallyConsistent(entry: ProductTailCacheEntry): boolean {
  let previous = 0;
  for (const message of entry.messages) {
    if (typeof message.messageId !== "string" || message.messageId.length === 0) return false;
    if (!safeCount(message.sequence, 1)) return false;
    if ((message.sequence as number) <= previous) return false;
    previous = message.sequence as number;
  }
  return entry.messages.length > 0 && previous === entry.tailSequence;
}

/**
 * Cold-start admission for one persisted entry against the current catalog
 * row. "open" is the only state that may render, and it always carries
 * `revalidateAfterSequence`: appends never move the content revision, so the
 * caller must still reconcile the tail with one afterSequence fetch (a fresh
 * window simply gets an empty page back). "purge" requires durable deletion
 * before the channel is usable; "closed" keeps the entry invisible without
 * destroying it (e.g. a catalog that omitted the watermark).
 */
export function decideProductTailCacheAdmission(
  entry: ProductTailCacheEntry,
  binding: ProductTailCacheChannelBinding,
  userId: string,
): ProductTailCacheAdmission {
  if (entry.schemaVersion !== PRODUCT_TAIL_CACHE_SCHEMA_VERSION) {
    return { decision: "purge", reason: "schema_version" };
  }
  if (entry.userId !== userId) return { decision: "purge", reason: "user_mismatch" };
  if (entry.channelId !== binding.channelId) {
    return { decision: "purge", reason: "channel_binding_changed" };
  }
  if (!safeCount(entry.appliedContentRevision)) {
    return { decision: "purge", reason: "applied_revision_invalid" };
  }
  const revision = binding.contentRevision;
  if (revision === undefined) return { decision: "closed", reason: "content_revision_unknown" };
  if (entry.appliedContentRevision > revision) {
    return { decision: "purge", reason: "content_revision_regressed" };
  }
  if (entry.appliedContentRevision < revision) {
    // Some already-served row changed (edit, recall, redaction, archive
    // drain). afterSequence cannot repair mutated rows; the bytes are stale.
    return { decision: "purge", reason: "content_revision_moved" };
  }
  if (!entryInternallyConsistent(entry)) return { decision: "purge", reason: "inconsistent_window" };
  const head = binding.historyHeadSequence;
  if (head === undefined) return { decision: "closed", reason: "head_unknown" };
  if (!safeCount(head)) return { decision: "purge", reason: "head_invalid" };
  if (entry.tailSequence > head) return { decision: "purge", reason: "head_regressed" };
  return {
    decision: "open",
    entry,
    revalidateAfterSequence: entry.tailSequence,
  };
}

/**
 * Global byte-budget plan: least-recently-accessed channels are evicted until
 * the remainder fits. Eviction is a cache miss, never a coverage claim.
 */
export function planProductTailCacheEviction(
  entries: Array<Pick<ProductTailCacheEntry, "channelId" | "encodedBytes" | "lastAccessAt">>,
  totalBudgetBytes: number = PRODUCT_TAIL_CACHE_TOTAL_BUDGET_BYTES,
): string[] {
  let total = entries.reduce((sum, entry) => sum + entry.encodedBytes, 0);
  if (total <= totalBudgetBytes) return [];
  const evictions: string[] = [];
  const byAccess = [...entries].sort((left, right) => left.lastAccessAt - right.lastAccessAt);
  for (const entry of byAccess) {
    if (total <= totalBudgetBytes) break;
    evictions.push(entry.channelId);
    total -= entry.encodedBytes;
  }
  return evictions;
}
