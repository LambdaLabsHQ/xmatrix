// Durable background outbox for extension message sends (inline popover card
// and side panel).
//
// When a person presses Enter in an inline card or side panel, the surface
// registers the send's idempotency keys (`requestKey` for conversation create
// + `clientMessageId` for message append) here in `chrome.storage.local` while
// still delivering optimistically in the UI.
//
// - Normal path: the UI finishes and calls `ack(clientMessageId)`, removing the
//   entry before the fallback delay expires (zero extra Hub requests).
// - Page closed / navigated / stalled / SW hibernated: the service worker
//   flushes the persisted entry directly to the Hub using the exact same
//   `requestKey` and `clientMessageId`. The Hub deduplicates both, guaranteeing
//   zero lost messages and zero duplicates.

import { HubError } from "./hub-client.js";

export const OUTBOX_STORAGE_KEY = "pendingOutbox";
export const OUTBOX_FAILURES_STORAGE_KEY = "outboxFailures";
export const OUTBOX_ALARM_NAME = "outbox-retry";

export const DEFAULT_FALLBACK_DELAY_MS = 20_000;
const RETRY_BACKOFF_MS = [3_000, 8_000, 20_000, 30_000];
const MAX_ATTEMPTS = 10;
const MAX_ENTRY_AGE_MS = 10 * 60 * 1000;
const MAX_STORED_ENTRIES = 50;
const MAX_STORED_FAILURES = 5;
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_TAB_TTL_MS = 10_000;
const ACKED_ID_TTL_MS = 60_000;

function nonEmptyString(value, maxLen = 1024) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

function sanitizeChannelCreate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const requestKey = nonEmptyString(raw.requestKey, 128);
  if (!requestKey) return null;
  const spaceId = nonEmptyString(raw.spaceId, 128);
  const name = nonEmptyString(raw.name, 300);
  const body = typeof raw.body === "string" ? raw.body.slice(0, 64 * 1024) : null;
  const memberName = nonEmptyString(raw.memberName, 300) ?? "Human";
  const mode = raw.mode === "closed" ? "closed" : "open";
  const metadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
    ? raw.metadata
    : undefined;
  return {
    requestKey,
    ...(spaceId ? { spaceId } : {}),
    ...(name ? { name } : {}),
    ...(body ? { body } : {}),
    mode,
    memberName,
    ...(metadata ? { metadata } : {}),
  };
}

function sanitizeEntry(raw, now, fallbackDelayMs) {
  if (!raw || typeof raw !== "object") return null;
  const clientMessageId = nonEmptyString(raw.clientMessageId, 128);
  const body = typeof raw.body === "string" ? raw.body.slice(0, 64 * 1024) : "";
  if (!clientMessageId || !body.trim()) return null;
  const channelCreate = sanitizeChannelCreate(raw.channelCreate);
  const channelId = nonEmptyString(raw.channelId, 128);
  if (!channelId && !channelCreate) return null;
  const spaceId = nonEmptyString(raw.spaceId, 128) ?? channelCreate?.spaceId ?? null;
  const userId = nonEmptyString(raw.userId, 128);
  const tabId = Number.isInteger(raw.tabId) ? raw.tabId : null;
  const source = raw.source === "sidepanel" ? "sidepanel" : "inline";
  const replyToMessageId = nonEmptyString(raw.replyToMessageId, 128);
  const appMentions = Array.isArray(raw.appMentions)
    ? raw.appMentions.filter((item) => item && (typeof item === "object" || (typeof item === "string" && item.trim()))).slice(0, 32)
    : undefined;
  const invocationSelections = raw.invocationSelections && typeof raw.invocationSelections === "object"
    ? raw.invocationSelections
    : undefined;
  const metadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
    ? raw.metadata
    : undefined;
  const title = nonEmptyString(raw.title, 300) ?? channelCreate?.name ?? null;
  const href = nonEmptyString(raw.href, 2000);
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const notBeforeAt = typeof raw.notBeforeAt === "number" && Number.isFinite(raw.notBeforeAt)
    ? raw.notBeforeAt
    : createdAt + fallbackDelayMs;
  const attempts = Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0;
  return {
    clientMessageId,
    ...(userId ? { userId } : {}),
    ...(tabId !== null ? { tabId } : {}),
    source,
    ...(channelId ? { channelId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(channelCreate ? { channelCreate } : {}),
    ...(raw.channelCreated === true ? { channelCreated: true } : {}),
    body,
    ...(invocationSelections ? { invocationSelections } : {}),
    ...(metadata ? { metadata } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(appMentions && appMentions.length > 0 ? { appMentions } : {}),
    ...(title ? { title } : {}),
    ...(href ? { href } : {}),
    createdAt,
    notBeforeAt,
    attempts,
  };
}

function isSilentDropError(error) {
  return error?.code === "signed_out" || error?.code === "account_mismatch";
}

function isPermanentFailure(error) {
  if (isSilentDropError(error)) return true;
  if (error instanceof HubError) {
    return error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status);
  }
  return false;
}

function failureRecordFrom(entry, reason, failedAt) {
  const rawBody = typeof entry?.body === "string" ? entry.body : "";
  const preview = rawBody.replace(/^>.*$/gmu, "").replace(/\s+/gu, " ").trim().slice(0, 120)
    || rawBody.replace(/\s+/gu, " ").trim().slice(0, 120);
  return {
    clientMessageId: entry.clientMessageId,
    title: String(entry.title || entry.channelCreate?.name || "").slice(0, 120),
    preview,
    error: String(reason || "Could not reach xMatrix.").slice(0, 200),
    failedAt,
  };
}

/**
 * Creates a persistent outbox backed by `storage` (chrome.storage.local shape)
 * and `alarms` (chrome.alarms shape), delegating actual Hub delivery to `deliver`.
 */
export function createOutbox({
  storage,
  alarms,
  deliver,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  fallbackDelayMs = DEFAULT_FALLBACK_DELAY_MS,
  maxAttempts = MAX_ATTEMPTS,
  maxEntryAgeMs = MAX_ENTRY_AGE_MS,
}) {
  let queue = Promise.resolve();
  const inFlightIds = new Set();
  const ackedIds = new Map();
  const recentlyClosedTabs = new Map();
  let wakeTimer = null;

  function serial(work) {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  }

  function pruneShortMaps() {
    const current = now();
    for (const [id, at] of ackedIds) {
      if (current - at > ACKED_ID_TTL_MS) ackedIds.delete(id);
    }
    for (const [tabId, at] of recentlyClosedTabs) {
      if (current - at > RECENT_TAB_TTL_MS) recentlyClosedTabs.delete(tabId);
    }
  }

  async function readFailures() {
    const data = await storage.get(OUTBOX_FAILURES_STORAGE_KEY).catch(() => ({}));
    const raw = data?.[OUTBOX_FAILURES_STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    const current = now();
    return raw
      .filter((item) => item && typeof item === "object"
        && typeof item.clientMessageId === "string"
        && typeof item.failedAt === "number"
        && current - item.failedAt <= FAILURE_TTL_MS)
      .slice(-MAX_STORED_FAILURES);
  }

  async function recordFailures(records) {
    if (!records.length) return;
    const existing = await readFailures();
    const byId = new Map(existing.map((item) => [item.clientMessageId, item]));
    for (const record of records) byId.set(record.clientMessageId, record);
    const next = [...byId.values()].slice(-MAX_STORED_FAILURES);
    await storage.set({ [OUTBOX_FAILURES_STORAGE_KEY]: next }).catch(() => undefined);
  }

  async function readEntries() {
    const data = await storage.get(OUTBOX_STORAGE_KEY).catch(() => ({}));
    const raw = data?.[OUTBOX_STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    const current = now();
    const valid = [];
    const expired = [];
    for (const item of raw) {
      const clean = sanitizeEntry(item, current, fallbackDelayMs);
      if (!clean) continue;
      if (current - clean.createdAt <= maxEntryAgeMs) {
        valid.push(clean);
      } else {
        expired.push(failureRecordFrom(clean, "Timed out before reaching xMatrix.", current));
      }
    }
    if (expired.length > 0) {
      await recordFailures(expired);
      await writeEntries(valid);
    }
    return valid.slice(-MAX_STORED_ENTRIES);
  }

  async function writeEntries(entries) {
    const trimmed = entries.slice(-MAX_STORED_ENTRIES);
    if (trimmed.length === 0) {
      await storage.remove(OUTBOX_STORAGE_KEY).catch(() => undefined);
    } else {
      await storage.set({ [OUTBOX_STORAGE_KEY]: trimmed }).catch(() => undefined);
    }
    await syncSchedule(trimmed);
  }

  async function syncSchedule(entries) {
    if (wakeTimer !== null) {
      clearTimer(wakeTimer);
      wakeTimer = null;
    }
    if (entries.length === 0) {
      await alarms?.clear?.(OUTBOX_ALARM_NAME)?.catch?.(() => undefined);
      return;
    }
    const current = now();
    let earliest = Infinity;
    for (const entry of entries) {
      if (inFlightIds.has(entry.clientMessageId)) continue;
      if (entry.notBeforeAt < earliest) earliest = entry.notBeforeAt;
    }
    if (Number.isFinite(earliest)) {
      const waitMs = Math.max(0, earliest - current);
      wakeTimer = setTimer(() => {
        wakeTimer = null;
        return flushDue().catch(() => undefined);
      }, waitMs);
    }
    await alarms?.create?.(OUTBOX_ALARM_NAME, { periodInMinutes: 0.5 })?.catch?.(() => undefined);
  }

  async function flushEntry(entry) {
    const id = entry.clientMessageId;
    if (inFlightIds.has(id) || ackedIds.has(id)) return false;
    inFlightIds.add(id);
    let delivered = false;
    let progress = null;
    try {
      await deliver(entry, {
        onChannelCreated: async ({ channelId, spaceId }) => {
          progress = { channelId, spaceId };
          await serial(async () => {
            const entries = await readEntries();
            const next = entries.map((item) => (item.clientMessageId === id
              ? { ...item, channelId, ...(spaceId ? { spaceId } : {}), channelCreated: true }
              : item));
            await writeEntries(next);
          });
        },
      });
      delivered = true;
      inFlightIds.delete(id);
      await serial(async () => {
        const entries = await readEntries();
        await writeEntries(entries.filter((item) => item.clientMessageId !== id));
      });
      return true;
    } catch (error) {
      inFlightIds.delete(id);
      const permanent = isPermanentFailure(error);
      const silent = isSilentDropError(error);
      const reason = error instanceof Error ? error.message : String(error ?? "Could not reach xMatrix.");
      await serial(async () => {
        pruneShortMaps();
        const entries = await readEntries();
        const current = now();
        if (ackedIds.has(id) || permanent) {
          const dropped = entries.find((item) => item.clientMessageId === id);
          if (dropped && permanent && !silent && !ackedIds.has(id)) {
            await recordFailures([failureRecordFrom(dropped, reason, current)]);
          }
          await writeEntries(entries.filter((item) => item.clientMessageId !== id));
          return;
        }
        const next = [];
        const givenUp = [];
        for (const item of entries) {
          if (item.clientMessageId !== id) {
            next.push(item);
            continue;
          }
          const nextAttempts = item.attempts + 1;
          if (nextAttempts >= maxAttempts || current - item.createdAt > maxEntryAgeMs) {
            givenUp.push(failureRecordFrom(item, reason, current));
            continue;
          }
          const delayMs = RETRY_BACKOFF_MS[Math.min(nextAttempts - 1, RETRY_BACKOFF_MS.length - 1)];
          next.push({
            ...item,
            ...(progress ? { channelId: progress.channelId, ...(progress.spaceId ? { spaceId: progress.spaceId } : {}), channelCreated: true } : {}),
            attempts: nextAttempts,
            notBeforeAt: current + delayMs,
          });
        }
        if (givenUp.length > 0) await recordFailures(givenUp);
        await writeEntries(next);
      });
      return delivered;
    } finally {
      inFlightIds.delete(id);
    }
  }

  /** Registers (or enriches) a pending send in persistent storage. */
  async function register(rawEntry) {
    let flushNowEntry = null;
    await serial(async () => {
      pruneShortMaps();
      const current = now();
      const incoming = sanitizeEntry(rawEntry, current, fallbackDelayMs);
      if (!incoming) return;
      if (ackedIds.has(incoming.clientMessageId)) return;
      const entries = await readEntries();
      const index = entries.findIndex((item) => item.clientMessageId === incoming.clientMessageId);
      let merged = incoming;
      if (index >= 0) {
        const existing = entries[index];
        merged = {
          ...existing,
          ...incoming,
          // Preserve original createdAt, attempts, channelCreate, and channelCreated progress.
          createdAt: existing.createdAt,
          notBeforeAt: Math.min(existing.notBeforeAt, incoming.notBeforeAt),
          attempts: existing.attempts,
          channelId: incoming.channelId ?? existing.channelId,
          spaceId: incoming.spaceId ?? existing.spaceId,
          channelCreate: existing.channelCreate ?? incoming.channelCreate,
          ...(existing.channelCreated ? { channelCreated: true } : {}),
          ...(incoming.appMentions?.length ? { appMentions: incoming.appMentions } : existing.appMentions ? { appMentions: existing.appMentions } : {}),
          ...(incoming.metadata ? { metadata: incoming.metadata } : existing.metadata ? { metadata: existing.metadata } : {}),
        };
        entries[index] = merged;
      } else {
        entries.push(merged);
      }
      await writeEntries(entries);
      if (merged.tabId !== undefined && recentlyClosedTabs.has(merged.tabId)) {
        flushNowEntry = merged;
      }
    });
    if (flushNowEntry) {
      await flushEntry(flushNowEntry);
    }
  }

  /** Marks a send confirmed (or permanently discarded) by the UI so background never retries it. */
  async function ack(clientMessageId) {
    const id = nonEmptyString(clientMessageId, 128);
    if (!id) return;
    await serial(async () => {
      pruneShortMaps();
      ackedIds.set(id, now());
      const entries = await readEntries();
      const remaining = entries.filter((item) => item.clientMessageId !== id);
      if (remaining.length !== entries.length) {
        await writeEntries(remaining);
      }
    });
  }

  /** Immediately flushes all pending sends belonging to a tab (e.g. on tab close or cross-document navigation). */
  async function flushForTab(tabId, { source = null, tabRemoved = false } = {}) {
    if (!Number.isInteger(tabId)) return;
    const targets = await serial(async () => {
      pruneShortMaps();
      if (tabRemoved) recentlyClosedTabs.set(tabId, now());
      const entries = await readEntries();
      return entries.filter((entry) => entry.tabId === tabId && (!source || entry.source === source));
    });
    if (targets.length === 0) return;
    await Promise.all(targets.map((entry) => flushEntry(entry)));
  }

  /** Flushes all persisted entries whose `notBeforeAt` deadline has arrived. */
  async function flushDue() {
    const targets = await serial(async () => {
      const current = now();
      const entries = await readEntries();
      await syncSchedule(entries);
      return entries.filter((entry) => entry.notBeforeAt <= current);
    });
    if (targets.length === 0) return;
    await Promise.all(targets.map((entry) => flushEntry(entry)));
  }

  /** Called on service worker startup/wakeup to resume persisted entries. */
  async function recover() {
    await flushDue();
  }

  /** Clears all pending sends and failure notices (e.g. on user sign-out). */
  async function clearAll() {
    await serial(async () => {
      ackedIds.clear();
      recentlyClosedTabs.clear();
      await storage.remove(OUTBOX_FAILURES_STORAGE_KEY).catch(() => undefined);
      await writeEntries([]);
    });
  }

  /** Clears persisted delivery-failure notices once the user dismisses them. */
  async function clearFailures() {
    await serial(async () => {
      await storage.remove(OUTBOX_FAILURES_STORAGE_KEY).catch(() => undefined);
    });
  }

  return {
    register,
    ack,
    flushForTab,
    flushDue,
    recover,
    clearAll,
    list: () => serial(readEntries),
    listFailures: () => serial(readFailures),
    clearFailures,
  };
}
