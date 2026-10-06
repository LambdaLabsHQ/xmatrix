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
    fetches++; assert.deepEqual(actual, connection); return [{ value: 'owner/repo', private: true }];
  });
  assert.deepEqual(await reader('human'), { repositories: ['owner/repo'] });
  assert.deepEqual(await reader('human'), { repositories: ['owner/repo'] });
  assert.equal(fetches, 1); assert.equal(reads, 1, 'the connection is read once; its version is not an authority');
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
