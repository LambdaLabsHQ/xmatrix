/*
 * Composio's proxy refuses a request body of a few MB, so a Gmail draft large enough to need Gmail's upload
 * endpoint cannot travel inline. Composio's `binary_body` can instead fetch the bytes from a URL: the Hub stages
 * the approved, checked snapshot under an unguessable 256-bit token, reserves a durable cleanup lease before
 * writing to R2, serves it at most until it expires (ten minutes), and deletes it as soon as the send ends
 * whether it succeeded or failed. The URL is the capability: it names nothing about the mailbox and is never
 * shown in a Channel.
 */
import { MAIL_SNAPSHOT_KEY_PATTERN, MAIL_SNAPSHOT_KEY_PREFIX, type MailSnapshotLease } from "@xmatrix/db";
import type { Env } from "../types";
import { connectorMailSnapshotLeaseRepository } from "./credentials";

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const RECONCILE_PAGE_LIMIT = 50;
const RECONCILE_MAX_PAGES = 4;
export const MAIL_SNAPSHOT_TTL_MS = 10 * 60_000;
export const MAIL_SNAPSHOT_ROUTE = "/api/connectors/mail-snapshots/";

export interface MailSnapshotLinks {
  /** Stage one snapshot; `remove` deletes it and is safe to call more than once. */
  stage(bytes: Uint8Array, contentType: string): Promise<{ url: string; remove(): Promise<void> }>;
}

export interface MailSnapshotLeaseStore {
  reserve(input: { requestId: string; objectKey: string; commandId: string; expiresAt: string }): Promise<MailSnapshotLease>;
  markDeleted(input: { requestId: string; objectKey: string }): Promise<boolean>;
  markDeleteFailed(input: { requestId: string; objectKey: string; baseDelayMs?: number; now?: string }): Promise<MailSnapshotLease | null>;
  due(input: { requestId: string; limit?: number; afterObjectKey?: string; now?: string }): Promise<MailSnapshotLease[]>;
}

export interface MailSnapshotLinksOptions {
  leases?: MailSnapshotLeaseStore;
  commandId?: string;
}

export interface MailSnapshotReconcileSummary {
  scanned: number;
  deleted: number;
  failed: number;
  more: boolean;
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function releaseLeaseSafely(leases: MailSnapshotLeaseStore | undefined, objectKey: string): Promise<void> {
  if (!leases) return;
  try {
    await leases.markDeleted({ requestId: crypto.randomUUID(), objectKey });
  } catch {
    console.warn("Gmail upload snapshot lease release failed");
  }
}

async function retryLeaseSafely(leases: MailSnapshotLeaseStore | undefined, objectKey: string, now?: string): Promise<void> {
  if (!leases) return;
  try {
    await leases.markDeleteFailed({ requestId: crypto.randomUUID(), objectKey, ...(now ? { now } : {}) });
  } catch {
    console.warn("Gmail upload snapshot lease retry update failed");
  }
}

export function mailSnapshotLinks(
  bucket: R2Bucket,
  hubUrl: string,
  now: () => number = Date.now,
  options: MailSnapshotLinksOptions = {},
): MailSnapshotLinks {
  const origin = hubUrl.trim().replace(/\/+$/u, "");
  if (!/^https:\/\/[^/]+$/u.test(origin)) throw new Error("HUB_URL must be the Hub's https origin to stage a mail snapshot");
  const { leases } = options;
  const commandId = options.commandId?.trim().slice(0, 200) || "gmail:snapshot";
  return {
    async stage(bytes, contentType) {
      const id = token();
      const objectKey = `${MAIL_SNAPSHOT_KEY_PREFIX}${id}`;
      const expiresAtMs = now() + MAIL_SNAPSHOT_TTL_MS;
      const expiresAt = new Date(expiresAtMs).toISOString();
      if (leases) {
        await leases.reserve({ requestId: crypto.randomUUID(), objectKey, commandId, expiresAt });
      }
      try {
        await bucket.put(objectKey, bytes, {
          httpMetadata: { contentType },
          customMetadata: { expiresAt: String(expiresAtMs) },
        });
      } catch (error) {
        try {
          await bucket.delete(objectKey);
          await releaseLeaseSafely(leases, objectKey);
        } catch {
          await retryLeaseSafely(leases, objectKey);
        }
        throw error;
      }
      const remove = async (): Promise<void> => {
        let deleteError: unknown;
        try {
          await bucket.delete(objectKey);
        } catch (error) {
          deleteError = error;
        }
        if (deleteError !== undefined) {
          await retryLeaseSafely(leases, objectKey);
          throw deleteError;
        }
        await releaseLeaseSafely(leases, objectKey);
      };
      return { url: `${origin}${MAIL_SNAPSHOT_ROUTE}${id}`, remove };
    },
  };
}

/** The staged snapshot for a valid, unexpired token; anything else is 404 with no detail. */
export async function serveMailSnapshot(
  bucket: R2Bucket | undefined,
  id: string,
  now: () => number = Date.now,
  leases?: MailSnapshotLeaseStore,
): Promise<Response> {
  const missing = () => new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (!bucket || !TOKEN.test(id)) return missing();
  const objectKey = `${MAIL_SNAPSHOT_KEY_PREFIX}${id}`;
  const object = await bucket.get(objectKey);
  if (!object) return missing();
  if (!(Number(object.customMetadata?.expiresAt) > now())) {
    await bucket.delete(objectKey);
    await releaseLeaseSafely(leases, objectKey);
    return missing();
  }
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Bounded, resumable, exact-key expiry and failed-delete reconciler. Deletes
 * only explicitly leased `connector-mail-snapshots/<token>` keys and never
 * lists or scans general attachment objects.
 */
export async function reconcileDueMailSnapshots(
  bucket: Pick<R2Bucket, "delete">,
  leases: MailSnapshotLeaseStore,
  options: { limit?: number; maxPages?: number; now?: string } = {},
): Promise<MailSnapshotReconcileSummary> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? RECONCILE_PAGE_LIMIT), 1), 100);
  const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? RECONCILE_MAX_PAGES), 1), 20);
  let scanned = 0;
  let deleted = 0;
  let failed = 0;
  let afterObjectKey: string | undefined;
  let more = false;

  for (let page = 0; page < maxPages; page++) {
    const due = await leases.due({
      requestId: crypto.randomUUID(),
      limit,
      ...(afterObjectKey ? { afterObjectKey } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    if (due.length === 0) break;
    for (const lease of due) {
      scanned++;
      afterObjectKey = lease.objectKey;
      if (!MAIL_SNAPSHOT_KEY_PATTERN.test(lease.objectKey)) {
        failed++;
        console.warn("Gmail upload snapshot reconciliation skipped invalid key");
        continue;
      }
      try {
        await bucket.delete(lease.objectKey);
        await releaseLeaseSafely(leases, lease.objectKey);
        deleted++;
      } catch {
        failed++;
        console.warn("Gmail upload snapshot reconciliation failed");
        await retryLeaseSafely(leases, lease.objectKey, options.now);
      }
    }
    if (due.length < limit) break;
    if (page + 1 === maxPages) more = true;
  }

  return { scanned, deleted, failed, more };
}

export async function reconcileMailSnapshotLeases(env: Env): Promise<MailSnapshotReconcileSummary> {
  if (!env.ATTACHMENT_BUCKET || !env.RELAY_POSTGRES?.connectionString || !env.RELAY_POSTGRES_SHARD_ID?.trim()) {
    return { scanned: 0, deleted: 0, failed: 0, more: false };
  }
  return reconcileDueMailSnapshots(env.ATTACHMENT_BUCKET, connectorMailSnapshotLeaseRepository(env));
}
