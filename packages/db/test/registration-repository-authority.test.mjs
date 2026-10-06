import assert from 'node:assert/strict';
import test from 'node:test';
import { registrationResourcesWithinOwnerScope, summonRepositoryCatalog } from '../dist/registration-repository-authority.js';
const requested = { workspaces: ['repo:owner/repo'], models: ['model'], secrets: [], capabilities: [] };
test('a repo workspace passes through without a directory grant or a connector check', () => {
  assert.deepEqual(registrationResourcesWithinOwnerScope(requested), { ...requested, workspaces: [] });
  assert.deepEqual(requested.workspaces, ['repo:owner/repo']);
  assert.deepEqual(registrationResourcesWithinOwnerScope({ ...requested, workspaces: ['owner/repo'] }), { ...requested, workspaces: [] });
  const local = { ...requested, workspaces: ['workspace'] };
  assert.equal(registrationResourcesWithinOwnerScope(local), local);
  const mixed = { ...requested, workspaces: ['workspace', 'repo:owner/repo'] };
  assert.equal(registrationResourcesWithinOwnerScope(mixed), mixed, 'only a single repository passes through');
});
test('Jev chooses among at most 100 catalog repositories', async () => {
  const repositories = Array.from({ length: 150 }, (_, index) => `owner/repo-${index}`);
  assert.deepEqual((await summonRepositoryCatalog(async () => ({ repositories }), 'human', undefined)).repositories, repositories.slice(0, 100));
  assert.equal(await summonRepositoryCatalog(async () => undefined, 'human', undefined), undefined);
});
test('a summon naming its repo reads no catalog; a failed catalog read offers none', async () => {
  const unread = () => assert.fail('a named repo reads no catalog');
  assert.deepEqual(await summonRepositoryCatalog(unread, 'human', 'owner/repo'), { repositories: ['owner/repo'] });
  assert.deepEqual(await summonRepositoryCatalog(unread, 'human', 'repo:owner/repo'), { repositories: ['owner/repo'] });
  assert.deepEqual(await summonRepositoryCatalog(unread, 'human', 'https://github.com/owner/repo'), { repositories: ['owner/repo'] });
  assert.deepEqual(await summonRepositoryCatalog(async actor => {
    assert.equal(actor, 'human'); return { repositories: ['owner/a'] };
  }, 'human', undefined), { repositories: ['owner/a'] });
  assert.equal(await summonRepositoryCatalog(async () => { throw new Error('GitHub down'); }, 'human', undefined), undefined);
  assert.equal(summonRepositoryCatalog(undefined, 'human', undefined), undefined);
});
