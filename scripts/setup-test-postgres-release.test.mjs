import { expandWorkflowAnchors, workflowSourceForJobs } from "./workflow-source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("tagged Hub deployment reuses only its exact request gate before production mutation", () => {
  // The request's Hub gate is CI's Hub job on the exact release commit: the
  // request passes that commit to ci.yml, and each job selects it after verification.
  const request = expandWorkflowAnchors(readFileSync(new URL("../.github/workflows/production-release-request.yml", import.meta.url), "utf8"));
  const gates = request.slice(request.indexOf("\n  ci:"), request.indexOf("\n  ios:"));
  assert.match(gates, /uses: \.\/\.github\/workflows\/ci\.yml[\s\S]*ref: \$\{\{ needs\.plan\.outputs\.deploy_sha \}\}/u);
  const ci = expandWorkflowAnchors(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const ciHub = ci.slice(ci.indexOf("\n  hub:"), ci.indexOf("\n  desktop:"));
  const checkout = ciHub.indexOf('git checkout --detach "$CI_RELEASE_REF"');
  const bootstrap = ciHub.indexOf("run: bash scripts/setup-test-postgres.sh");
  const gate = ciHub.indexOf("node scripts/ci.mjs ${{ matrix.partition }}");
  assert.ok(checkout >= 0 && bootstrap > checkout && gate > bootstrap);

  const workflow = workflowSourceForJobs(readFileSync(new URL("../.github/workflows/server-release.yml", import.meta.url), "utf8"), ["hub"]);
  const tagged = workflow.indexOf("name: Verify exact clean tagged checkout");
  const proof = workflow.indexOf("name: Reverify exact selected request before reusing its test result");
  const deploy = workflow.indexOf("name: Deploy tagged Hub to production");
  assert.ok(tagged >= 0 && proof > tagged && deploy > proof);
  assert.match(workflow.slice(proof, deploy), /uses: \.\/\.github\/actions\/reverify-release-gate[\s\S]*component: hub/u);
  const reuse = readFileSync(new URL("../.github/actions/reverify-release-gate/action.yml", import.meta.url), "utf8");
  assert.match(reuse, /scripts\/release-commit\.mjs", process\.env\.RELEASE_CHANNEL === "stable" \? "verify-cut" : "verify",/u);
  assert.doesNotMatch(workflow, /node scripts\/ci\.mjs hub|run: bash scripts\/setup-test-postgres\.sh/u);
  assert.doesNotMatch(workflow.slice(tagged, deploy), /continue-on-error|CLOUDFLARE_API_TOKEN/u);
});
