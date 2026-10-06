import assert from 'node:assert/strict';
import test from 'node:test';
import {
  launchChannelContext,
} from "../src/registration-launch-context.ts";
const input = { channelId: 'channel', sourceMessageId: 'source', sourceSequence: 9,
  catalog: { channels: [{ id: 'channel', name: 'Routing', topic: 'Repo alpha', metadata: { secret: 'private' } }],
    pathsByChannelId: { channel: ['channel'] } }, history: { hasMore: true, messages: [
      { messageId: 'earlier', channelId: 'channel', sequence: 8, body: 'Inspect alpha', from: { email: 'private' } },
      { messageId: 'later', channelId: 'channel', sequence: 10, body: 'Future instruction' },
      { messageId: 'other', channelId: 'private', sequence: 7, body: 'private' },
      { messageId: 'recalled', channelId: 'channel', sequence: 6, body: 'private', recalledAt: 'now' },
    ] } };
test('context contains preceding channel content and topic, not future or private projection fields', () => {
  const result = launchChannelContext(input);
  assert.deepEqual(result.messages.map(message => message.messageId), ['earlier']);
  assert.equal(result.hierarchy[0].topic, 'Repo alpha');
  assert.equal(result.historyTruncated, true);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.throws(() => launchChannelContext({ ...input, catalog: { channels: [], pathsByChannelId: {} } }), /unavailable/);
});
test('context enforces a UTF-8 JSON byte bound and marks truncation', () => {
  const huge = structuredClone(input);
  huge.catalog.channels = Array.from({ length: 9 }, (_, index) => ({ id: index === 8 ? 'channel' : `parent${index}`,
    name: '中文'.repeat(1000), topic: '\u0000'.repeat(3000), summary: '🌍'.repeat(3000) }));
  huge.catalog.pathsByChannelId.channel = huge.catalog.channels.map(channel => channel.id);
  huge.history.messages = Array.from({ length: 30 }, (_, index) => ({ channelId: 'channel', messageId: `m${index}`,
    sequence: index + 1, body: '中文🌍'.repeat(3000) }));
  const result = launchChannelContext({ ...huge, sourceSequence: 31 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12000);
  assert.equal(result.fieldsTruncated, true);
  assert.equal(result.hierarchyTruncated, true);
  assert.equal(result.historyTruncated, true);
  assert.equal(result.hierarchy.at(-1).channelId, 'channel');
});
