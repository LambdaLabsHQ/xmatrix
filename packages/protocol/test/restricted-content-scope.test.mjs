import assert from 'node:assert/strict';
import test from 'node:test';
import { restrictedChannelContentScope, parseRestrictedChannelContentScope, immutableContentObjectKey } from '../dist/index.js';

test('restricted content scopes preserve opaque IDs and isolate equal content hashes', () => {
  const hash = 'a'.repeat(64);
  const first = restrictedChannelContentScope('channel:one', 'user:one');
  const second = restrictedChannelContentScope('channel:one', 'user:two');
  assert.deepEqual(parseRestrictedChannelContentScope(first), { channelId: 'channel:one', readerUserId: 'user:one' });
  assert.notEqual(immutableContentObjectKey(first, hash), immutableContentObjectKey(second, hash));
  assert.notEqual(immutableContentObjectKey(first, hash), immutableContentObjectKey('channel:one', hash));
  assert.equal(immutableContentObjectKey('channel:one', hash), `objects/${hash}`);
  for (const scope of ['channel-user::user', 'channel-user:channel:%75ser', 'channel-user:channel:user:extra', 'channel-user:channel:%']) {
    assert.throws(() => parseRestrictedChannelContentScope(scope));
  }
});
