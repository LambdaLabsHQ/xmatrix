import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanupSummonDecisions,
} from "../src/summon-decision-cleanup.ts";

test('collector deletes only leased keys, confirms only successful deletion and continues after failure', async () => {
  const deleted = [], completed = [];
  const content = {
    async retireDecisionUploads() { return 0; },
    async expireDecisionRefs(input) { assert.equal(input.limit, 50); return { expired: 4 }; },
    async dueDecisionObjects(input) { assert.equal(input.limit, 10); return ['retained', 'failure', 'success']; },
    async claimDecisionObject({ objectKey }) { return objectKey === 'retained' ? null : { objectKey, objectId: objectKey, version: 2 }; },
    async completeDecisionObject(input) { completed.push(input.objectId); assert.equal(input.version, 2); return true; },
  };
  const result = await cleanupSummonDecisions({ content, spaceId: 'space', bucket: {
    async delete(key) { deleted.push(key); if (key === 'failure') throw new Error('storage unavailable'); },
  } });
  assert.deepEqual(deleted, ['failure', 'success']);
  assert.deepEqual(completed, ['success']);
  assert.deepEqual(result, { retiredUploads: 0, expired: 4, deleted: 1, deferred: 2 });
});

test('failed authority claim never causes physical deletion', async () => {
  await assert.rejects(cleanupSummonDecisions({ spaceId: 'space', content: {
    async retireDecisionUploads() { return 0; },
    async expireDecisionRefs() { return { expired: 0 }; }, async dueDecisionObjects() { return ['key']; },
    async claimDecisionObject() { throw new Error('authority unavailable'); },
    async completeDecisionObject() { assert.fail('no completion'); },
  }, bucket: { async delete() { assert.fail('no deletion'); } } }));
});

test('a stalled storage delete is bounded and keeps the lease resumable', async () => {
  const result = await cleanupSummonDecisions({ spaceId: 'space', deleteTimeoutMs: 5, content: {
    async retireDecisionUploads() { return 0; },
    async expireDecisionRefs() { return { expired: 0 }; }, async dueDecisionObjects() { return ['key']; },
    async claimDecisionObject() { return { objectKey: 'key', objectId: 'object', version: 2 }; },
    async completeDecisionObject() { assert.fail('no completion for unconfirmed deletion'); },
  }, bucket: { async delete() { return new Promise(() => {}); } } });
  assert.deepEqual(result, { retiredUploads: 0, expired: 0, deleted: 0, deferred: 1 });
});
