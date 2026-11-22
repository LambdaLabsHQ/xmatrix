import assert from "node:assert/strict";
import { test } from "node:test";
import { GMAIL_ACTIONS as ACTIONS } from "../src/connectors/actions/gmail.ts";
import {
  MAIL_SNAPSHOT_TTL_MS,
  mailSnapshotLinks,
  reconcileDueMailSnapshots,
  serveMailSnapshot,
} from "../src/connectors/mail-snapshot-link.ts";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";

function bucket() {
  const objects = new Map();
  const events = [];
  const failDelete = new Set();
  let failNextPut = false;
  return {
    objects,
    events,
    failDelete,
    setFailNextPut(value) { failNextPut = value; },
    async put(key, bytes, options) {
      events.push(["put", key]);
      if (failNextPut) {
        failNextPut = false;
        throw new Error("R2 put interrupted");
      }
      objects.set(key, { bytes, ...options });
    },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: object.bytes, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata } : null;
    },
    async delete(key) {
      events.push(["delete", key]);
      if (failDelete.has(key)) throw new Error("R2 delete failed");
      objects.delete(key);
    },
  };
}

function leaseStore(events, nowRef) {
  const rows = new Map();
  return {
    rows,
    async reserve({ objectKey, commandId, expiresAt }) {
      events.push(["reserve", objectKey, commandId]);
      const row = { objectKey, commandId, state: "staged", expiresAt, nextAttemptAt: expiresAt, attempts: 0 };
      rows.set(objectKey, row);
      return row;
    },
    async markDeleted({ objectKey }) {
      events.push(["markDeleted", objectKey]);
      return rows.delete(objectKey);
    },
    async markDeleteFailed({ objectKey, baseDelayMs = 15_000, now }) {
      events.push(["markDeleteFailed", objectKey]);
      const row = rows.get(objectKey);
      if (!row) return null;
      const delay = Math.min(300_000, baseDelayMs * 2 ** Math.min(row.attempts, 5));
      const baseMs = now ? Date.parse(now) : nowRef();
      const updated = { ...row, state: "delete_pending", attempts: row.attempts + 1, nextAttemptAt: new Date(baseMs + delay).toISOString() };
      rows.set(objectKey, updated);
      return updated;
    },
    async due({ limit = 50, afterObjectKey, now }) {
      const cutoff = now ? Date.parse(now) : nowRef();
      return [...rows.values()]
        .filter((row) => Date.parse(row.nextAttemptAt) <= cutoff && (!afterObjectKey || row.objectKey > afterObjectKey))
        .sort((a, b) => (a.objectKey < b.objectKey ? -1 : a.objectKey > b.objectKey ? 1 : 0))
        .slice(0, limit);
    },
  };
}

test("a staged mail snapshot is served by its unguessable token until it expires or is removed", async () => {
  const store = bucket();
  let now = 1_000;
  const leases = leaseStore(store.events, () => now);
  const links = mailSnapshotLinks(store, "https://hub.test/", () => now, { leases, commandId: "approval:req-1" });
  const staged = await links.stage(new TextEncoder().encode("MIME"), "multipart/related; boundary=b");
  const token = staged.url.match(/^https:\/\/hub\.test\/api\/connectors\/mail-snapshots\/([A-Za-z0-9_-]{43})$/u)[1];
  const key = `connector-mail-snapshots/${token}`;
  assert.deepEqual(store.events.slice(0, 2), [["reserve", key, "approval:req-1"], ["put", key]],
    "reserves durable cleanup lease before writing bytes to R2");
  const served = await serveMailSnapshot(store, token, () => now, leases);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "multipart/related; boundary=b");
  assert.equal(served.headers.get("cache-control"), "no-store");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.equal(new TextDecoder().decode(await served.arrayBuffer()), "MIME");
  for (const guess of ["", "short", `${token}x`, "../../etc/passwd"]) assert.equal((await serveMailSnapshot(store, guess, () => now, leases)).status, 404);
  now += MAIL_SNAPSHOT_TTL_MS;
  assert.equal((await serveMailSnapshot(store, token, () => now, leases)).status, 404, "an expired snapshot is not served");
  assert.equal(store.objects.size, 0, "and is deleted when asked for");
  assert.equal(leases.rows.size, 0, "and releases its durable lease");
  const again = await links.stage(new Uint8Array([1]), "x/y");
  await again.remove();
  await again.remove();
  assert.equal(store.objects.size, 0);
  assert.equal(leases.rows.size, 0);
  assert.throws(() => mailSnapshotLinks(store, "http://hub.test"), /https origin/u);
  assert.equal((await serveMailSnapshot(undefined, token)).status, 404);
});

test("interrupted staging, failed delete, expiry, and concurrent completion reconcile exact keys without touching attachments", async () => {
  const store = bucket();
  let now = 10_000;
  const leases = leaseStore(store.events, () => now);
  const links = mailSnapshotLinks(store, "https://hub.test", () => now, { leases, commandId: "command:msg-1" });
  store.objects.set("objects/protected-attachment-hash", { bytes: new Uint8Array([9, 9]) });

  // 1. Interrupted after put (process restarts before remove() is ever called)
  const abandoned = await links.stage(new Uint8Array([1, 2]), "multipart/related; boundary=a");
  const abandonedKey = `connector-mail-snapshots/${abandoned.url.split("/").at(-1)}`;

  // 2. Interrupted during put when cleanup also fails -> retryable delete_pending lease
  store.setFailNextPut(true);
  const beforeFailedPut = new Set(leases.rows.keys());
  await assert.rejects(() => links.stage(new Uint8Array([3]), "multipart/related; boundary=b"), /R2 put interrupted/u);
  const failedPutKey = [...leases.rows.keys()].find((key) => !beforeFailedPut.has(key));
  assert.equal(failedPutKey, undefined, "clean delete on failed put releases the lease immediately");

  // 3. Normal send completes, immediate delete fails -> lease becomes delete_pending
  const failedDelete = await links.stage(new Uint8Array([4, 5]), "multipart/related; boundary=c");
  const failedDeleteKey = `connector-mail-snapshots/${failedDelete.url.split("/").at(-1)}`;
  store.failDelete.add(failedDeleteKey);
  await assert.rejects(() => failedDelete.remove(), /R2 delete failed/u);
  assert.equal(leases.rows.get(failedDeleteKey)?.state, "delete_pending");
  assert.equal(leases.rows.get(failedDeleteKey)?.attempts, 1);

  // Before expiry/backoff, reconciler does not touch live staged or backed-off snapshots
  const early = await reconcileDueMailSnapshots(store, leases, { now: new Date(now + 1_000).toISOString() });
  assert.deepEqual(early, { scanned: 0, deleted: 0, failed: 0, more: false });
  assert.equal(store.objects.has(abandonedKey), true);

  // After retry backoff passes while R2 delete still fails, reconciler logs fixed warning and backs off again
  const retryFail = await reconcileDueMailSnapshots(store, leases, { now: new Date(now + 20_000).toISOString() });
  assert.deepEqual(retryFail, { scanned: 1, deleted: 0, failed: 1, more: false });
  assert.equal(leases.rows.get(failedDeleteKey)?.attempts, 2);

  // After TTL expires and R2 recovers, bounded reconciler drains both abandoned and failedDelete keys across pages
  store.failDelete.delete(failedDeleteKey);
  const drained = await reconcileDueMailSnapshots(store, leases, {
    limit: 1,
    maxPages: 4,
    now: new Date(now + MAIL_SNAPSHOT_TTL_MS + 60_000).toISOString(),
  });
  assert.deepEqual(drained, { scanned: 2, deleted: 2, failed: 0, more: false });
  assert.equal(store.objects.has(abandonedKey), false);
  assert.equal(store.objects.has(failedDeleteKey), false);
  assert.equal(leases.rows.size, 0);
  assert.equal(store.objects.has("objects/protected-attachment-hash"), true, "ordinary attachment objects are never touched");

  // Concurrent completion: remove() after reconciler already deleted the key is idempotent
  await abandoned.remove();
  assert.equal(leases.rows.size, 0);
});

test("Gmail send preserves confirmed provider outcome when immediate snapshot delete fails and never retries the send", async () => {
  const store = bucket();
  let now = 50_000;
  const leases = leaseStore(store.events, () => now);
  const realLinks = mailSnapshotLinks(store, "https://hub.test", () => now, { leases, commandId: "approval:send-1" });
  const mailSnapshot = {
    async stage(bytes, contentType) {
      const staged = await realLinks.stage(bytes, contentType);
      const key = `connector-mail-snapshots/${staged.url.split("/").at(-1)}`;
      store.failDelete.add(key);
      return staged;
    },
  };
  const mailbox = { account: "ca_mailbox1", address: "me@example.com", owner: "user:user-1" };
  const credentials = { mailboxes: JSON.stringify([mailbox]), composioApiKey: "composio-project-key" };
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    const fullDraft = {
      body: {
        status: 200,
        data: {
          id: "draft-1",
          message: {
            id: "m1",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: "me@example.com" },
                { name: "To", value: "ops@example.com" },
                { name: "Subject", value: "Big" },
              ],
              body: { data: Buffer.from("Draft body").toString("base64url") },
            },
          },
        },
      },
    };
    const rawDraft = Buffer.from("From: me@example.com\r\nTo: ops@example.com\r\nSubject: Big\r\n\r\nDraft body").toString("base64url");
    const rawResponse = { body: { status: 200, data: { id: "draft-1", message: { id: "m1", raw: rawDraft } } } };
    const sent = { body: { status: 200, data: { id: "19a0b1c2d3e4f5a6" } } };
    const ctx = { credentials, caller: { userId: "user-1" }, mailSnapshot };
    const frozen = await fetched([fullDraft], () => ACTIONS.send_draft.prepare(ctx, { id: "draft-1" }));
    const res = await fetched([rawResponse, sent], () => ACTIONS.send_draft.execute(ctx, frozen.result));
    assert.equal(res.calls.length, 2, "only fetches draft and sends once; never retries the external send");
    assert.match(res.result.summary, /Sent Gmail draft draft-1 as message 19a0b1c2d3e4f5a6/u);
    assert.deepEqual(warnings, ["Gmail upload snapshot cleanup failed"]);
    const remaining = [...leases.rows.values()];
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].state, "delete_pending");
    assert.equal(remaining[0].commandId, "approval:send-1");
    assert.equal(warnings.some((line) => line.includes(remaining[0].objectKey) || line.includes("me@example.com")), false,
      "operational warning is fixed and leaks neither snapshot token nor mailbox");
  } finally {
    console.warn = origWarn;
  }
});
