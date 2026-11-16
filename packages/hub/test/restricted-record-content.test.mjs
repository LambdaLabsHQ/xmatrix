import assert from "node:assert/strict";
import test from "node:test";
import { ContentControlError } from "@xmatrix/db";
import { writeRestrictedRecord } from "../src/restricted-record-content.ts";

function fixture({ commitError } = {}) {
  const intents = [], commits = [];
  const content = {
    async createIntent(input) { intents.push(input); return input; },
    async commitRef(input) { commits.push(input); if (commitError) throw commitError; return input; },
  };
  const bucket = { async head() { return null; }, async put(_key, body, options) {
    const bytes = await new Response(body).arrayBuffer();
    return { size: bytes.byteLength, etag: "verified", checksums: { sha256: await crypto.subtle.digest("SHA-256", bytes) },
      customMetadata: options.customMetadata };
  } };
  const write = (kind, payload) => writeRestrictedRecord({ content, bucket, actorUserId: "owner", channelId: "channel",
    refId: "connector-result:app:gmail:route:1a1d171d81c04a5b:channel", ownerId: "message", kind, payload, maximumBytes: 4096 });
  return { intents, commits, write };
}

test("a record written again after an earlier write is its own commands for the same record", async () => {
  const f = fixture();
  await f.write("connector_result", { version: 1, detail: "body" });
  await f.write("connector_result", { version: 1, detail: "body" });
  // The intent's expiry and the commit's verification time differ per write; reusing the
  // earlier command ids was refused as a reused command on every retry.
  assert.notEqual(f.intents[0].commandId, f.intents[1].commandId);
  assert.notEqual(f.intents[0].intentId, f.intents[1].intentId);
  assert.notEqual(f.commits[0].commandId, f.commits[1].commandId);
  assert.equal(f.commits[0].refId, f.commits[1].refId);
  assert.equal(f.commits[1].intentId, f.intents[1].intentId);
  assert.ok(f.intents.every(intent => intent.intentId.length <= 160));
});

test("a connector result already saved for its message stands; a decision conflict still fails", async () => {
  const conflict = new ContentControlError("blob_ref_conflict", 409, "refId was reused with another object");
  await fixture({ commitError: conflict }).write("connector_result", { version: 1, detail: "re-read" });
  await assert.rejects(fixture({ commitError: conflict }).write("summon_decision", { version: 1 }),
    error => error.stage === "commit");
  await assert.rejects(fixture({ commitError: new Error("storage unavailable") }).write("connector_result", { version: 1, detail: "x" }),
    error => error.stage === "commit");
});
