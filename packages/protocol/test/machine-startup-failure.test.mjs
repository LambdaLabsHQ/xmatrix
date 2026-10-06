import assert from "node:assert/strict";
import test from "node:test";
import { publicMachineStartupFailure, repositoryAccessUnavailableDetail } from "../dist/machine-startup-failure.js";

test("repository preparation errors have bounded, fixed public explanations", () => {
  for (const [detail, code] of [["base_ref_unresolved", "repository_base_unresolved"],
    ["disk_exhausted", "machine_disk_full"], ["fetch_required_failed", "repository_fetch_failed"]]) {
    const failure = publicMachineStartupFailure(`${detail}: /private/SECRET_SENTINEL`);
    assert.equal(failure.code, code);
    assert.ok(failure.action);
    assert.doesNotMatch(JSON.stringify(failure), /SECRET_SENTINEL/u);
  }
  for (const value of [null, {}, "unknown failure SECRET_SENTINEL", "not_base_ref_unresolved"]) {
    assert.equal(publicMachineStartupFailure(value), undefined);
  }
});

test("a repository the Space's GitHub connection cannot reach is named, with what to check", () => {
  // The Hub's mint refusal, carried verbatim through the daemon's startup failure.
  const refusal = repositoryAccessUnavailableDetail("LambdaLabsHQ/xmatrix", "github_api_422");
  assert.equal(refusal, "repository_access_unavailable: the Space's GitHub connection cannot access LambdaLabsHQ/xmatrix (github_api_422)");
  const minted = publicMachineStartupFailure(
    `this Space's GitHub connector could not authorize LambdaLabsHQ/xmatrix (${refusal}) /private/SECRET_SENTINEL`);
  assert.deepEqual(minted, { code: "repository_access_unavailable",
    summary: "The Space's GitHub connection can't access LambdaLabsHQ/xmatrix.",
    action: "Check that the Space's GitHub app installation includes LambdaLabsHQ/xmatrix and that GitHub is connected in the Space's Apps, then summon again." });
  // GitHub refusing the fetch names no repository; the copy stays generic and
  // wins over a plain fetch failure.
  const fetched = publicMachineStartupFailure("repo pool lease unavailable (fetch_required_failed: repository_access_unavailable: GitHub refused the Space's credential (repository not found)) SECRET_SENTINEL");
  assert.equal(fetched.code, "repository_access_unavailable");
  assert.match(fetched.summary, /can't access the selected repository/u);
  for (const failure of [minted, fetched]) assert.doesNotMatch(JSON.stringify(failure), /SECRET_SENTINEL|private/u);
  assert.doesNotMatch(repositoryAccessUnavailableDetail("../../etc", "x"), /\.\.\//u);
});
