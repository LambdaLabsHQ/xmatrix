import { requirePublishedMaintenanceTarget } from './postgres-lifecycle-maintenance-policy.mjs';

export const ONESHOT_REMOVAL_COMMIT = '2787ebe7d6b6783766b9ad2564e7eca19a5579ed';

/** A fixed data retirement operator, never a generic SQL/script executor. */
export function requireAgentLifecycleCleanupAuthority(input) {
  requirePublishedMaintenanceTarget(input);
  if (input.actorPermission !== 'admin') throw new Error('cleanup requires a repository administrator');
  if (input.removalIncluded !== true) throw new Error('production does not contain the reviewed removal');
  if (input.productionRuns.some(run => ['queued', 'in_progress', 'waiting', 'pending'].includes(run.status))) {
    throw new Error('wait for active Production Releases to finish');
  }
  const dryRun = String(input.dryRun);
  if (!['true', 'false'].includes(dryRun)) throw new Error('dry_run is invalid');
  if (!['10000', '100000'].includes(String(input.maxRows))) throw new Error('max_rows is invalid');
  if (dryRun === 'false' && input.confirmation !== `REMOVE ONESHOT FROM ${input.tag}`) {
    throw new Error('exact retirement confirmation is required');
  }
  return { dryRun: dryRun === 'true', maxRows: Number(input.maxRows) };
}

/** Read fresh authority immediately before either preview or mutation. */
export async function authorizeAgentLifecycleCleanup({ github, context, dryRun, maxRows, confirmation }) {
  const tag = context.ref.replace('refs/tags/', '');
  const ref = (await github.rest.git.getRef({ ...context.repo, ref: `tags/${tag}` })).data.object;
  if (ref.type !== 'tag') throw new Error('an annotated production tag is required');
  const target = (await github.rest.git.getTag({ ...context.repo, tag_sha: ref.sha })).data.object;
  if (target.type !== 'commit') throw new Error('the tag must point to a commit');
  const productionRuns = (await github.rest.actions.listWorkflowRuns({
    ...context.repo, workflow_id: 'production-release.yml', event: 'workflow_dispatch', per_page: 100,
    uncached: `${context.runId}-${Date.now()}`, headers: { 'cache-control': 'no-cache' },
  })).data.workflow_runs;
  const actorPermission = (await github.rest.repos.getCollaboratorPermissionLevel({
    ...context.repo, username: context.actor,
  })).data.permission;
  const comparison = (await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo, basehead: `${ONESHOT_REMOVAL_COMMIT}...${context.sha}`,
  })).data.status;
  return requireAgentLifecycleCleanupAuthority({ tag, currentSha: context.sha, tagCommitSha: target.sha,
    productionRuns, actorPermission, removalIncluded: ['identical', 'ahead'].includes(comparison),
    dryRun, maxRows, confirmation });
}
