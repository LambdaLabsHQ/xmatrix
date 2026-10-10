import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PostgresAppRepository,
} from "@xmatrix/db";
import {
  registrationRepositoryCatalog,
} from "../src/registration-repository-catalog.ts";
const connection = { id: 'space:github', spaceId: 'space', providerId: 'github', providerName: 'GitHub', status: 'configured', version: 7 };
test('registration and composer consume the same Space repository catalog without machine filters', async t => {
  let reads = 0, fetches = 0;
  t.mock.method(PostgresAppRepository.prototype, 'getConnection', async input => {
    reads++; assert.equal(input.actorUserId, 'human'); assert.equal(input.connectionId, 'space:github'); return { connection };
  });
  const reader = registrationRepositoryCatalog({}, { cacheMode: 'disabled' }, 'space', async (_env, actual) => {
    fetches++; assert.deepEqual(actual, connection); return [{ value: 'owner/repo', private: true,
      description: 'Routes inference requests across providers' }];
  });
  const expected = { repositories: ['owner/repo'], descriptions: { 'owner/repo': 'Routes inference requests across providers' } };
  assert.deepEqual(await reader('human'), expected);
  assert.deepEqual(await reader('human'), expected);
  assert.equal(fetches, 1); assert.equal(reads, 1, 'the connection is read once; its version is not an authority');
});

test('repository descriptions have a serialized byte bound, including Unicode and escapes', async t => {
  t.mock.method(PostgresAppRepository.prototype, 'getConnection', async () => ({ connection }));
  const descriptions = ['模型路由😀'.repeat(200), '\\"\n'.repeat(200), '   ', undefined];
  const reader = registrationRepositoryCatalog({}, { cacheMode: 'disabled' }, 'space', async () =>
    descriptions.map((description, index) => ({ value: `owner/repo-${index}`, private: true, description })));
  const catalog = await reader('human');
  assert.deepEqual(catalog.repositories, ['owner/repo-0', 'owner/repo-1', 'owner/repo-2', 'owner/repo-3']);
  for (const [repo, description] of Object.entries(catalog.descriptions)) {
    assert.ok(Buffer.byteLength(JSON.stringify(description)) <= 256);
    assert.ok(descriptions[Number(repo.at(-1))].trim().startsWith(description));
    assert.ok(description.length > 0);
    assert.doesNotMatch(description, /[\uD800-\uDBFF]$/u);
  }
  assert.equal(catalog.descriptions['owner/repo-2'], undefined);
  assert.equal(catalog.descriptions['owner/repo-3'], undefined);
});
test('a Space without a configured GitHub connection offers no repository', async t => {
  t.mock.method(PostgresAppRepository.prototype, 'getConnection', async () => ({ connection: null }));
  const reader = registrationRepositoryCatalog({}, { cacheMode: 'disabled' }, 'space', async () => assert.fail('no GitHub lookup'));
  assert.equal(await reader('human'), undefined);
  t.mock.method(PostgresAppRepository.prototype, 'getConnection', async () => ({ connection: { ...connection, status: 'disconnected' } }));
  assert.equal(await registrationRepositoryCatalog({}, { cacheMode: 'disabled' }, 'space',
    async () => assert.fail('no GitHub lookup'))('human'), undefined);
});
test('an installation with more than 100 repositories is read whole', async t => {
  t.mock.method(PostgresAppRepository.prototype, 'getConnection', async () => ({ connection }));
  const repos = Array.from({ length: 150 }, (_, index) => ({ value: `owner/repo-${index}`, private: false }));
  const reader = registrationRepositoryCatalog({}, { cacheMode: 'disabled' }, 'space', async () => repos);
  assert.equal((await reader('human')).repositories.length, 150);
});
