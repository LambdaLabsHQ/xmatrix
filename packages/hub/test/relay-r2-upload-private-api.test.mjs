import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cloudflareRelayPrivateR2UploadPort,
} from "../src/relay-r2-upload-private-api.ts";
import { handleRelayR2UploadVerify, handleRelayR2BlobRefCommit, handleRelayR2UploadIntentCreate } from "../src/relay-r2-upload-private-api.ts";
import { ControlError } from '@xmatrix/db';

const HASH = "ab".repeat(32);

function storedObject(etag = "created-etag") {
  return {
    size: 3,
    etag,
    checksums: { sha256: Uint8Array.from({ length: 32 }, () => 0xab).buffer },
    customMetadata: {
      "xmatrix-content-hash": HASH,
      "xmatrix-encoded-size": "3",
    },
  };
}

const uploadInput = {
  contentLength: 3,
  checksumSha256: HASH,
  customMetadata: {
    "xmatrix-content-hash": HASH,
    "xmatrix-encoded-size": "3",
  },
};

test("a successful conditional R2 upload uses the returned verified object without HEAD round trips", async () => {
  let headCalls = 0;
  let putCalls = 0;
  const port = cloudflareRelayPrivateR2UploadPort({
    async head() {
      headCalls += 1;
      return null;
    },
    async put(_key, _body, options) {
      putCalls += 1;
      assert.deepEqual(options.onlyIf, { etagDoesNotMatch: "*" });
      assert.equal(options.sha256, HASH);
      return storedObject();
    },
  });

  const result = await port.putIfAbsent("objects/test", new Uint8Array([1, 2, 3]).buffer, uploadInput);

  assert.equal(putCalls, 1);
  assert.equal(headCalls, 0);
  assert.equal(result.outcome, "created");
  assert.equal(result.metadata.checksumSha256, HASH);
});

test("a lost conditional R2 upload race reads and verifies the winning object once", async () => {
  let headCalls = 0;
  const winner = storedObject("winner-etag");
  const port = cloudflareRelayPrivateR2UploadPort({
    async head() {
      headCalls += 1;
      return winner;
    },
    async put() {
      return null;
    },
  });

  const result = await port.putIfAbsent("objects/test", new Uint8Array([1, 2, 3]).buffer, uploadInput);

  assert.equal(headCalls, 1);
  assert.equal(result.outcome, "exists");
  assert.equal(result.metadata.etag, "winner-etag");
});

test('knowing a restricted payload hash cannot verify it through a public or different-user intent', async () => {
  const { immutableContentObjectKey } = await import('@xmatrix/protocol');
  const originalScope = 'channel-user:channel:user-one';
  const originalKey = immutableContentObjectKey(originalScope, HASH);
  const readKeys = [];
  const bucket = { async head(key) { readKeys.push(key); return key === originalKey ? storedObject() : null; } };
  const verify = scope => handleRelayR2UploadVerify({ principal: { kind: 'user', id: 'user-one' }, intentId: 'intent-one', bucket,
    content: { async readIntent() { return { intentId: 'intent-one', scopeId: scope,
      contentHash: HASH, checksum: HASH, objectKey: immutableContentObjectKey(scope, HASH), encodedBytes: 3,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'pending', version: 1 }; } } });
  assert.equal((await verify(originalScope)).status, 200);
  for (const scope of ['channel:channel', 'channel-user:channel:user-two']) {
    await assert.rejects(verify(scope), error => error.code === 'object_not_verified');
    assert.notEqual(readKeys.at(-1), originalKey);
  }
});

const unreachableContent = new Proxy({}, { get: () => async () => { assert.fail('must not reach content authority'); } });

test('public blob commit cannot forge server-authored summon evidence', async () => {
  await assert.rejects(handleRelayR2BlobRefCommit({
    request: new Request('https://internal/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'request',
      intentId: 'intent', refId: 'ref', ownerKind: 'summon_decision', ownerId: 'source', visibilityScopeId: 'channel-user:channel:user' }) }),
    principal: { kind: 'user', id: 'user' }, now: Date.now(), bucket: {},
    content: unreachableContent,
  }), error => error.code === 'not_authorized');
});

test('public upload cannot claim the internal decision purpose', async () => {
  await assert.rejects(handleRelayR2UploadIntentCreate({
    request: new Request('https://internal/intent', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'request', intentId: 'intent', visibilityScopeId: 'channel-user:channel:user',
        contentHash: HASH, encodedSize: 3, expiresAt: Date.now() + 60000, purpose: 'summon_decision' }) }),
    principal: { kind: 'user', id: 'user' }, now: Date.now(),
    content: unreachableContent,
  }), error => error.code === 'invalid_request');
});

test('a Space-scope upload is referenced into a Channel, which sets who sees it', async () => {
  const { immutableContentObjectKey } = await import('@xmatrix/protocol');
  const commit = async (intentScope, refScope) => {
    const committed = [];
    const content = {
      async readRef() { throw new ControlError('blob_ref_not_found', 404, 'not found'); },
      async readIntent() { return { intentId: 'intent', scopeId: intentScope,
        contentHash: HASH, checksum: HASH, objectKey: immutableContentObjectKey(intentScope, HASH), encodedBytes: 3,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'pending', version: 1 }; },
      async commitRef(body) { committed.push(body); return { refId: 'ref', scopeId: body.scopeId }; },
    };
    await handleRelayR2BlobRefCommit({
      request: new Request('https://internal/commit', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'request', intentId: 'intent', refId: 'ref',
          ownerKind: 'message_attachment', ownerId: 'message', visibilityScopeId: refScope }) }),
      principal: { kind: 'user', id: 'user' }, now: Date.now(),
      bucket: { async head() { return storedObject(); } }, content,
    });
    return committed;
  };
  // The authority holds the intent to the ref's own Space.
  assert.deepEqual((await commit('space:space', 'channel:closed')).map(({ scopeId, objectKey }) => ({ scopeId, objectKey })),
    [{ scopeId: 'channel:closed', objectKey: `objects/${HASH}` }]);
  for (const [intentScope, refScope] of [['channel:closed', 'space:space'], ['channel:closed', 'channel:other']]) {
    await assert.rejects(commit(intentScope, refScope), error => error.code === 'not_authorized');
  }
});
