import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeAgentLifecycleCleanup, requireAgentLifecycleCleanupAuthority } from './agent-lifecycle-cleanup-policy.mjs';

const input = () => ({ tag: 'xmatrix-v0.16.500', currentSha: 'a'.repeat(40), tagCommitSha: 'a'.repeat(40),
  actorPermission: 'admin', removalIncluded: true, dryRun: 'true', maxRows: '10000', confirmation: '',
  productionRuns: [{ id: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    head_branch: 'xmatrix-v0.16.500', head_sha: 'a'.repeat(40) }] });

test('preview and apply bind to the successful immutable production and explicit confirmation', () => {
  assert.deepEqual(requireAgentLifecycleCleanupAuthority(input()), { dryRun: true, maxRows: 10000 });
  assert.deepEqual(requireAgentLifecycleCleanupAuthority({ ...input(), dryRun: 'false', maxRows: '100000',
    confirmation: 'REMOVE ONESHOT FROM xmatrix-v0.16.500' }), { dryRun: false, maxRows: 100000 });
});

test('unreviewed, stale, active, unprivileged and widened cleanup requests fail closed', () => {
  for (const override of [{ tag: 'main' }, { currentSha: 'b'.repeat(40) }, { actorPermission: 'write' },
    { removalIncluded: false }, { dryRun: 'maybe' }, { dryRun: 'false' }, { maxRows: '1000000' },
    { productionRuns: [] }, { productionRuns: [{ ...input().productionRuns[0], head_sha: 'b'.repeat(40) }] },
    { productionRuns: [...input().productionRuns, { id: 2, status: 'queued' }] },
    { productionRuns: [...input().productionRuns, { ...input().productionRuns[0], id: 2, head_branch: 'xmatrix-v0.16.501' }] }]) {
    assert.throws(() => requireAgentLifecycleCleanupAuthority({ ...input(), ...override }));
  }
});

test('authorization refreshes production facts and rejects a release that began while the job queued', async () => {
  let runs = input().productionRuns;
  let lists = 0;
  const github = { rest: {
    git: { getRef: async () => ({ data: { object: { type: 'tag', sha: 'tag-object' } } }),
      getTag: async () => ({ data: { object: { type: 'commit', sha: input().currentSha } } }) },
    actions: { listWorkflowRuns: async args => { lists++; assert.equal(args.per_page, 100);
      return { data: { workflow_runs: runs } }; } },
    repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'admin' } }),
      compareCommitsWithBasehead: async () => ({ data: { status: 'ahead' } }) },
  } };
  const request = { github, context: { ref: `refs/tags/${input().tag}`, sha: input().currentSha,
    actor: 'owner', repo: { owner: 'o', repo: 'r' } }, dryRun: 'true', maxRows: '10000' };
  await authorizeAgentLifecycleCleanup(request);
  runs = [...runs, { id: 2, status: 'in_progress' }];
  await assert.rejects(authorizeAgentLifecycleCleanup(request), /active Production/);
  assert.equal(lists, 2);
});
