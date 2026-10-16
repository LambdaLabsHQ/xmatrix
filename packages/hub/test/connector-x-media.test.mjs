import assert from "node:assert/strict";
import { test } from "node:test";
import { createXMediaCapability } from "../src/connectors/x-media.ts";
import { createXMediaActions } from "../src/connectors/actions/x-media.ts";

const account = { id: "101", username: "company", generation: "grant-1" };
const sourceRef = { messageId: "message-1", attachmentId: "video-1" };
const secret = "dedicated-test-signing-material-32-bytes";
const CHUNK = 1024 * 1024;

function fixture(options = {}) {
  const bytes = options.bytes ?? new Uint8Array(CHUNK * 2 + 13).map((_, index) => index % 251);
  const state = { allowed: true, writeAllowed: true, connected: [account], name: "video.mp4", size: bytes.length,
    mimeType: "video/mp4", hash: "a".repeat(64), r2Hash: "a".repeat(64), version: 1,
    processing: { state: "pending", check_after_secs: 2 }, providerId: "303", expires: 3600,
    errorAt: undefined, revokeAt: undefined, ...options };
  const calls = [], authorityCalls = [], writes = [], billing = [];
  const dependencies = { spaceId: "space-1", channelId: "channel-1", actorUserId: "user-1", receiptSecret: secret,
    authorizeWrite: async () => {
      writes.push("write");
      if (!state.writeAllowed) throw new Error("Channel policy revoked");
    },
    x: {
      accounts: async () => state.connected,
      reserveMedia: async maximum => {
        billing.push({ maximum, beforeCalls: calls.length });
        return async () => { billing.push({ settledAfter: calls.length }); };
      },
      async request(selected, method, path, body) {
        calls.push({ account: selected, method, path, body });
        if (path === state.errorAt) throw new TypeError("response lost after sending");
        if (path === state.revokeAt) state.allowed = false;
        if (path.endsWith("/initialize")) return { data: { id: "303", expires_after_secs: state.expires } };
        if (path.endsWith("/append")) return { data: { expires_at: 123 } };
        return { data: { id: state.providerId, expires_after_secs: state.expires,
          ...(state.processing ? { processing_info: state.processing } : {}) } };
      },
    },
    async attachmentAuthority(request) {
      authorityCalls.push(request);
      if (!state.allowed) return Response.json({ error: "attachment denied" }, { status: 403 });
      return Response.json({ channelId: request.channelId, messageId: request.messageId, visibilityScopeId: "space:space-1",
        attachment: { id: request.attachmentId, name: state.name, mimeType: state.mimeType, size: state.size, version: state.version },
        object: { checksum: state.hash, contentHash: state.hash, encodedBytes: state.size, objectKey: `objects/${state.hash}` } });
    },
    bucket: { async get() {
      return { body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), size: state.size,
        customMetadata: { sha256: state.r2Hash }, checksums: {}, etag: "immutable-etag" };
    } },
  };
  const media = createXMediaCapability(dependencies);
  return { media, dependencies, state, calls, authorityCalls, writes, bytes, billing };
}

// These tests own the outbound media boundary: the provider must see only an
// approved immutable attachment, and a receipt must not move it across grants.
// Existing product-media tests own basic attachment reads; existing generic
// approval tests own consume-once scheduling, rather than repeating either here.
test("X video upload streams exact ordered chunks using the official v2 JSON protocol", async () => {
  const f = fixture();
  const prepared = await f.media.prepareUpload(account, sourceRef);
  assert.deepEqual(prepared, { ...sourceRef, sourceName: "video.mp4", sourceSize: String(f.bytes.length),
    sourceHash: "a".repeat(64), sourceVersion: "1" });
  assert.equal(f.calls.length, 0, "preparing approval cannot create provider media");
  assert.equal(f.billing.length, 0, "asking for approval never reserves credits");
  const result = await f.media.upload(account, prepared);
  assert.deepEqual(f.billing, [{ maximum: 5, beforeCalls: 0 }, { settledAfter: 5 }],
    "the entire immutable chunk bound is reserved before initialize and settled after finalize");
  assert.equal(result.mediaId, "303");
  assert.equal(result.state, "pending");
  assert.equal(result.checkAfterSeconds, 2);
  assert.deepEqual(f.calls[0], { account, method: "POST", path: "/2/media/upload/initialize",
    body: { media_type: "video/mp4", media_category: "tweet_video", total_bytes: f.bytes.length } });
  const appended = f.calls.filter(call => call.path.endsWith("/append"));
  assert.deepEqual(appended.map(call => call.body.segment_index), [0, 1, 2]);
  assert.deepEqual(appended.map(call => Buffer.from(call.body.media, "base64").length), [CHUNK, CHUNK, 13]);
  assert.deepEqual(Buffer.concat(appended.map(call => Buffer.from(call.body.media, "base64"))), Buffer.from(f.bytes));
  assert.deepEqual(f.calls.at(-1), { account, method: "POST", path: "/2/media/upload/303/finalize", body: undefined });
  assert.equal(f.writes.length, 5, "each provider mutation rechecks Channel write policy");
  assert.ok(f.authorityCalls.length >= 5, "source authority is rechecked during the upload");
  for (const call of f.authorityCalls) assert.deepEqual(call,
    { channelId: "channel-1", ...sourceRef, principal: { kind: "user", id: "user-1" } });
  assert.match(result.receipt, /^xm1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u);
  assert.doesNotMatch(result.receipt, /dedicated-test-signing-material/u);
  assert.ok(result.receipt.length <= 4096);
  f.state.processing = { state: "succeeded" };
  assert.equal(await f.media.ready(account, result.receipt), "303");
  assert.equal(f.calls.at(-1).path, "/2/media/upload?command=STATUS&media_id=303");
});

test("X video approval rejects changed source metadata, removed accounts, and revoked source ACL before mutation", async () => {
  for (const change of [
    state => { state.name = "replacement.mp4"; }, state => { state.version = 2; },
    state => { state.size += 1; }, state => { state.hash = state.r2Hash = "b".repeat(64); },
    state => { state.connected = [{ ...account, generation: "grant-2" }]; }, state => { state.allowed = false; },
    state => { state.r2Hash = "b".repeat(64); },
  ]) {
    const f = fixture({ bytes: new Uint8Array([1, 2, 3]) });
    const prepared = await f.media.prepareUpload(account, sourceRef);
    change(f.state);
    await assert.rejects(f.media.upload(account, prepared));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ bytes: new Uint8Array([1]) });
  const prepared = await f.media.prepareUpload(account, sourceRef);
  f.state.writeAllowed = false;
  await assert.rejects(f.media.upload(account, prepared), /Channel policy revoked/u);
  assert.equal(f.calls.length, 0);
});

test("X video source is an explicitly scoped bounded MP4 attachment, never an arbitrary URL or path", async () => {
  for (const source of [
    { messageId: "https://evil.example/file.mp4", attachmentId: "video-1" },
    { messageId: "message-1", attachmentId: "../../secret" }, { messageId: "", attachmentId: "video-1" },
  ]) {
    const f = fixture();
    await assert.rejects(f.media.prepareUpload(account, source), /message ID and attachment ID/u);
    assert.equal(f.authorityCalls.length, 0);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await f.media.prepareUpload(account, { ...sourceRef, channelId: "outside-channel" });
  assert.equal(f.authorityCalls[0].channelId, "channel-1", "untyped metadata cannot replace the server scope");
  for (const change of [ { mimeType: "image/png" }, { size: 64 * 1024 * 1024 + 1 }, { name: "x".repeat(256) } ]) {
    const bad = fixture(change);
    await assert.rejects(bad.media.prepareUpload(account, sourceRef), /MP4 Channel attachment/u);
    assert.equal(bad.calls.length, 0);
  }
  const unsigned = fixture();
  unsigned.dependencies.receiptSecret = "";
  await assert.rejects(unsigned.media.prepareUpload(account, sourceRef), /receipt security/u);
});

test("X video receipts fail closed across account generations, principals, Spaces, Channels, tampering and expiry", async t => {
  const f = fixture({ bytes: new Uint8Array([1, 2]), processing: undefined });
  const prepared = await f.media.prepareUpload(account, sourceRef);
  const { receipt } = await f.media.upload(account, prepared);
  f.calls.length = 0;
  for (const selected of [{ ...account, id: "202" }, { ...account, generation: "grant-2" }]) {
    await assert.rejects(f.media.status(selected, receipt), /different Channel or X account/u);
  }
  for (const changed of [{ spaceId: "space-2" }, { channelId: "channel-2" }, { actorUserId: "user-2" }]) {
    const other = createXMediaCapability({ ...f.dependencies, ...changed });
    await assert.rejects(other.status(account, receipt), /different Channel or X account/u);
  }
  await assert.rejects(f.media.status(account, receipt.slice(0, -1) + (receipt.endsWith("0") ? "1" : "0")), /unmodified video receipt/u);
  await assert.rejects(f.media.status(account, "303"), /unmodified video receipt/u);
  f.state.connected = [{ ...account, generation: "grant-2" }];
  await assert.rejects(f.media.status(account, receipt), /approved X account changed/u);
  f.state.connected = [account];
  f.state.allowed = false;
  await assert.rejects(f.media.status(account, receipt), /not available/u);
  f.state.allowed = true;
  const future = Date.now() + 3600_001;
  t.mock.method(Date, "now", () => future);
  await assert.rejects(f.media.status(account, receipt), /expired/u);
  assert.equal(f.calls.length, 0, "invalid references must never cause a provider status request");
});

test("X video ready checks live provider processing once and never treats pending, failed or mismatched media as attachable", async () => {
  const f = fixture({ bytes: new Uint8Array([1]) });
  const { receipt } = await f.media.upload(account, await f.media.prepareUpload(account, sourceRef));
  for (const [processing, reason] of [
    [{ state: "pending", check_after_secs: 2 }, /still processing.*after 2 seconds/u],
    [{ state: "in_progress" }, /still processing/u], [{ state: "failed" }, /processing failed/u],
    [{ state: "invented" }, /valid video processing state/u], [{ state: "pending", check_after_secs: -1 }, /valid video processing state/u],
  ]) {
    f.state.processing = processing;
    const before = f.calls.length;
    await assert.rejects(f.media.ready(account, receipt), reason);
    assert.equal(f.calls.length, before + 1, "status checks do not start an unbounded polling loop");
  }
  f.state.processing = { state: "succeeded" };
  f.state.providerId = "404";
  await assert.rejects(f.media.ready(account, receipt), /different or invalid media ID/u);
});

test("X video upload never retries an uncertain mutation, stops after mid-upload revocation, and refuses storage truncation", async () => {
  const uncertain = fixture({ errorAt: "/2/media/upload/303/append" });
  await assert.rejects(uncertain.media.upload(account, await uncertain.media.prepareUpload(account, sourceRef)), /response lost/u);
  assert.equal(uncertain.calls.filter(call => call.path.endsWith("/append")).length, 1);
  assert.ok(!uncertain.calls.some(call => call.path.endsWith("/finalize")));
  const revoked = fixture({ revokeAt: "/2/media/upload/303/append" });
  await assert.rejects(revoked.media.upload(account, await revoked.media.prepareUpload(account, sourceRef)), /not available/u);
  assert.equal(revoked.calls.filter(call => call.path.endsWith("/append")).length, 1);
  assert.ok(!revoked.calls.some(call => call.path.endsWith("/finalize")));
  for (const size of [1, 3]) {
    const corrupt = fixture({ bytes: new Uint8Array([1, 2]), size });
    const prepared = await corrupt.media.prepareUpload(account, sourceRef);
    await assert.rejects(corrupt.media.upload(account, prepared), /size failed immutable storage verification/u);
    assert.ok(!corrupt.calls.some(call => call.path.endsWith("/finalize")));
  }
});

test("X video deadline stops after the first slow segment without sending another segment or finalizing", async t => {
  let now = Date.now();
  const clock = t.mock.method(Date, "now", () => now);
  try {
    const f = fixture();
    const request = f.dependencies.x.request;
    f.dependencies.x.request = async (...args) => {
      const response = await request(...args);
      if (args[2].endsWith("/append")) now += 120_001;
      return response;
    };
    const prepared = await f.media.prepareUpload(account, sourceRef);
    await assert.rejects(f.media.upload(account, prepared), error => error.status === 504 && /upload timed out/u.test(error.message));
    assert.deepEqual(f.calls.map(call => call.path), ["/2/media/upload/initialize", "/2/media/upload/303/append"],
      "the upload deadline is shorter than the still-valid one-hour media receipt");
  } finally { clock.mock.restore(); }
});

test("X media command parsers reject unscoped sources and raw media IDs", () => {
  const actions = createXMediaActions({});
  for (const target of ["*", "company", "@company/path"]) {
    assert.equal(typeof actions.upload_video.parse({ target, text: "message-1/video-1" }), "string");
  }
  for (const text of ["https://example.com/video.mp4", "/home/user/video.mp4", "message/video/extra", "message/video extra"]) {
    assert.equal(typeof actions.upload_video.parse({ target: "@company", text }), "string");
  }
  assert.deepEqual(actions.upload_video.parse({ target: "@company", text: "message-1/video-1" }),
    { account: "@company", messageId: "message-1", attachmentId: "video-1" });
  assert.equal(typeof actions.media_status.parse({ target: "101", text: "303" }), "string");
});
