import { expandWorkflowAnchors } from "./workflow-source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Label sets observed through the repository/organization runner APIs. The
// extra uploader labels must never make it eligible for ordinary test jobs.
export const runners = {
  uploader: ["self-hosted", "Linux", "X64", "local-linux-x64", "xmatrix-cf-deploy", "xmatrix-release-uploader"],
  workstation: ["self-hosted", "Linux", "X64", "local-linux-x64", "xmatrix-linux-release", "xmatrix-pg-migration-fast", "xmatrix-ci-linux"],
  offload: ["xmatrix-ci-offload"],
  linuxCi: ["self-hosted", "Linux", "X64", "local-linux-x64", "xmatrix-ci-linux"],
  dedicatedUploader: ["self-hosted", "xmatrix-release-uploader"],
  // The US machines run every Linux release job.
  usRelease: ["self-hosted", "xmatrix-release-uploader", "xmatrix-us-deploy", "xmatrix-us-release"],
  usReleaseFull: ["self-hosted", "Linux", "X64", "local-linux-x64", "xmatrix-cf-deploy", "xmatrix-release-uploader", "xmatrix-us-deploy", "xmatrix-us-release"],
  // Release validation has its own runners on the US machines, beside their PR CI runners.
  releaseTest: ["xmatrix-release-test"],
  usCi: ["self-hosted", "Linux", "X64", "local-linux-x64", "xmatrix-ci-linux"],
};
export const SELF_HOSTED_FLEET =
  /^    runs-on: \$\{\{ vars\.XMATRIX_RUNNER_FLEET == 'self-hosted' && fromJSON\('(\[[^']+\])'\) \|\| '[^']+' \}\}/mu;

// ci.yml selects GitHub-hosted runners when its caller says so, for a fork pull request, when
// XMATRIX_RUNNER_FLEET names them, or (unset) for a public repository.
const HOSTED_FLEET = "(inputs.hosted || github.event.pull_request.head.repo.fork || vars.XMATRIX_RUNNER_FLEET == 'github-hosted' || "
  + "(vars.XMATRIX_RUNNER_FLEET != 'self-hosted' && github.event.repository.private == false))";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function jobSource(workflow, job) {
  const source = expandWorkflowAnchors(readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8"));
  const section = source.match(new RegExp(`^  ${job}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, "mu"));
  assert.ok(section, `${workflow} contains ${job}`);
  return section[0];
}

export function eligible(source, labels) {
  const selector = source.match(/^    runs-on: \[([^\]]+)\]/mu);
  if (selector) return selector[1].split(",").every((label) => labels.includes(label.trim()));
  // Release jobs run on GitHub-hosted runners unless the repository opts into its own fleet.
  const fleet = source.match(SELF_HOSTED_FLEET);
  if (fleet) return JSON.parse(fleet[1]).every((label) => labels.includes(label));
  // Reusable CI permits hosted compute; validate the private fallback against
  // the same observed runner inventories and deployment isolation boundary.
  const fallback = source.match(new RegExp(
    `^    runs-on: \\$\\{\\{ fromJSON\\(inputs\\.(?:linux|offload|windows)_runner \\|\\| \\(${escapeRegExp(HOSTED_FLEET)} && '"[^']+"' \\|\\| '(\\[[^']+\\])'\\)\\) \\}\\}`,
    "mu",
  ));
  assert.ok(fallback, "test jobs use explicit labels or a typed CI runner input");
  return JSON.parse(fallback[1]).every((label) => labels.includes(label));
}
