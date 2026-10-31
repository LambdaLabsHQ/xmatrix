import { RELEASE_TAG_PATTERN } from "./release-version-order.mjs";

const REQUEST_PATH = ".github/workflows/production-postgres-lifecycle-maintenance-request.yml";

export function lifecycleRequestTitle(dryRun, maxRows) {
  return `PostgreSQL lifecycle request ${dryRun}-${maxRows}`;
}

export function lifecycleExecutionTitle(brokerRunId, dryRun, maxRows) {
  return `Production PostgreSQL lifecycle ${brokerRunId} ${dryRun} ${maxRows}`;
}

export function requireLifecycleExecutionAuthority(input) {
  const dryRun = String(input.dryRun);
  const maxRows = String(input.maxRows);
  const brokerRunId = String(input.broker?.id ?? "");
  requirePublishedMaintenanceTarget(input);
  if (input.broker?.path !== REQUEST_PATH || input.broker?.event !== "workflow_dispatch"
    && input.broker?.event !== "schedule") {
    throw new Error("maintenance broker identity is invalid");
  }
  if (input.broker?.head_branch !== "main" || input.broker?.conclusion !== "success"
    || !input.brokerIsInMain) {
    throw new Error("maintenance broker must be a successful main-history run");
  }
  if (dryRun !== "true" && dryRun !== "false") throw new Error("dry_run is invalid");
  if (!["10000", "100000", "1000000"].includes(maxRows)) throw new Error("max_rows is invalid");
  const expectedRequestTitle = lifecycleRequestTitle(dryRun, maxRows);
  if (input.broker?.display_title !== expectedRequestTitle) {
    throw new Error("maintenance parameters do not match the broker receipt");
  }
  const expectedExecutionTitle = lifecycleExecutionTitle(brokerRunId, dryRun, maxRows);
  if (input.currentDisplayTitle !== expectedExecutionTitle) {
    throw new Error("maintenance execution identity does not match the broker receipt");
  }
  const replay = input.sameTagRuns.some((run) => run.id !== input.currentRunId
    && run.display_title === expectedExecutionTitle);
  if (replay) throw new Error("maintenance broker receipt has already been consumed");
  return { brokerRunId, dryRun: dryRun === "true", maxRows: Number(maxRows) };
}

/**
 * The release maintenance runs from: the newest successful Production Release
 * of the line that deploys the Hub. Once betas exist that is the newest beta; a
 * stable rebuilds an older beta's source and never deploys the Hub, so it never is.
 * Before the first beta it is the newest release of the single line before it.
 */
export function latestMaintenanceRelease(productionRuns) {
  const releases = productionRuns.filter((run) => run.conclusion === "success" && run.event === "workflow_dispatch"
    && RELEASE_TAG_PATTERN.test(run.head_branch));
  const betas = releases.filter((run) => run.head_branch.includes("-beta."));
  return (betas.length ? betas : releases).sort((left, right) => right.id - left.id)[0];
}

const OPEN_RELEASE_STATUSES = new Set(["queued", "in_progress", "waiting", "requested"]);

/**
 * The broker's full success list is in flight for tens of seconds, so a release
 * that succeeds during that read is missing from it. `recent` is a second,
 * short success read taken after it. An open run only delays dispatch when
 * treating it as already successful would change which tag is latest.
 */
export function resolveMaintenanceRelease({ history = [], recent = [], openRuns = [] } = {}) {
  const release = latestMaintenanceRelease([...history, ...recent]) ?? null;
  const wait = openRuns.some((run) => {
    if (!OPEN_RELEASE_STATUSES.has(run.status)) return false;
    if (run.event && run.event !== "workflow_dispatch") return false;
    const winner = latestMaintenanceRelease([
      ...history, ...recent,
      { ...run, conclusion: "success", event: "workflow_dispatch" },
    ]);
    return Boolean(winner && winner.id === run.id && (!release || winner.id !== release.id));
  });
  return { release, wait };
}

/** Shared immutable-production boundary for bounded maintenance operators. */
export function requirePublishedMaintenanceTarget(input) {
  if (!RELEASE_TAG_PATTERN.test(input.tag)) throw new Error("maintenance requires a production release tag");
  if (input.currentSha !== input.tagCommitSha) throw new Error("maintenance SHA must equal the annotated tag target");
  const latestProduction = latestMaintenanceRelease(input.productionRuns);
  if (latestProduction?.head_branch !== input.tag
    || latestProduction?.head_sha !== input.currentSha) {
    throw new Error("tag is not the latest successful exact-SHA Production Release");
  }
}
