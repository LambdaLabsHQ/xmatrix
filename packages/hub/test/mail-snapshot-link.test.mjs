import assert from "node:assert/strict";
import { test } from "node:test";
import { MAIL_SNAPSHOT_TTL_MS, mailSnapshotLinks, serveMailSnapshot } from "../src/connectors/mail-snapshot-link.ts";

function bucket() {
  const objects = new Map();
  return { objects,
    async put(key, bytes, options) { objects.set(key, { bytes, ...options }); },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: object.bytes, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata } : null;
    },
    async delete(key) { objects.delete(key); } };
}

test("a staged mail snapshot is served by its unguessable token until it expires or is removed", async () => {
  const store = bucket();
  let now = 1_000;
  const links = mailSnapshotLinks(store, "https://hub.test/", () => now);
  const staged = await links.stage(new TextEncoder().encode("MIME"), "multipart/related; boundary=b");
  const token = staged.url.match(/^https:\/\/hub\.test\/api\/connectors\/mail-snapshots\/([A-Za-z0-9_-]{43})$/u)[1];
  const served = await serveMailSnapshot(store, token, () => now);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "multipart/related; boundary=b");
  assert.equal(served.headers.get("cache-control"), "no-store");
  assert.equal(new TextDecoder().decode(await served.arrayBuffer()), "MIME");
  for (const guess of ["", "short", `${token}x`, "../../etc/passwd"]) assert.equal((await serveMailSnapshot(store, guess, () => now)).status, 404);
  now += MAIL_SNAPSHOT_TTL_MS;
  assert.equal((await serveMailSnapshot(store, token, () => now)).status, 404, "an expired snapshot is not served");
  assert.equal(store.objects.size, 0, "and is deleted when asked for");
  const again = await links.stage(new Uint8Array([1]), "x/y");
  await again.remove();
  await again.remove();
  assert.equal(store.objects.size, 0);
  assert.throws(() => mailSnapshotLinks(store, "http://hub.test"), /https origin/u);
  assert.equal((await serveMailSnapshot(undefined, token)).status, 404);
});
