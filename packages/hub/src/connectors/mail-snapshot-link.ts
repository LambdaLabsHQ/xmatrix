/*
 * Composio's proxy refuses a request body of a few MB, so a Gmail draft large enough to need Gmail's upload
 * endpoint cannot travel inline. Composio's `binary_body` can instead fetch the bytes from a URL: the Hub stages
 * the approved, checked snapshot under an unguessable 256-bit token, serves it at most until it expires (ten
 * minutes) and deletes it as soon as the send ends, whether it succeeded or failed. The URL is the capability: it
 * names nothing about the mailbox and is never shown in a Channel.
 */
const PREFIX = "connector-mail-snapshots/";
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
export const MAIL_SNAPSHOT_TTL_MS = 10 * 60_000;
export const MAIL_SNAPSHOT_ROUTE = "/api/connectors/mail-snapshots/";

export interface MailSnapshotLinks {
  /** Stage one snapshot; `remove` deletes it and is safe to call more than once. */
  stage(bytes: Uint8Array, contentType: string): Promise<{ url: string; remove(): Promise<void> }>;
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function mailSnapshotLinks(bucket: R2Bucket, hubUrl: string, now: () => number = Date.now): MailSnapshotLinks {
  const origin = hubUrl.trim().replace(/\/+$/u, "");
  if (!/^https:\/\/[^/]+$/u.test(origin)) throw new Error("HUB_URL must be the Hub's https origin to stage a mail snapshot");
  return {
    async stage(bytes, contentType) {
      const id = token();
      await bucket.put(`${PREFIX}${id}`, bytes, { httpMetadata: { contentType },
        customMetadata: { expiresAt: String(now() + MAIL_SNAPSHOT_TTL_MS) } });
      return { url: `${origin}${MAIL_SNAPSHOT_ROUTE}${id}`, remove: () => bucket.delete(`${PREFIX}${id}`) };
    },
  };
}

/** The staged snapshot for a valid, unexpired token; anything else is 404 with no detail. */
export async function serveMailSnapshot(bucket: R2Bucket | undefined, id: string, now: () => number = Date.now): Promise<Response> {
  const missing = () => new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (!bucket || !TOKEN.test(id)) return missing();
  const object = await bucket.get(`${PREFIX}${id}`);
  if (!object) return missing();
  if (!(Number(object.customMetadata?.expiresAt) > now())) {
    await bucket.delete(`${PREFIX}${id}`);
    return missing();
  }
  return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
