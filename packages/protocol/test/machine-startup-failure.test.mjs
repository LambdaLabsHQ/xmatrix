import assert from "node:assert/strict";
import test from "node:test";
import { publicMachineStartupFailure, repositoryAccessUnavailableDetail } from "../dist/machine-startup-failure.js";

test("repository preparation errors have the original cause with stable codes", () => {
  for (const [detail, code] of [["base_ref_unresolved", "repository_base_unresolved"],
    ["disk_exhausted", "machine_disk_full"], ["fetch_required_failed", "repository_fetch_failed"]]) {
    const failure = publicMachineStartupFailure(`${detail}: /private/SECRET_SENTINEL`);
    assert.equal(failure.code, code);
    assert.equal(failure.action, "");
    assert.match(failure.summary, new RegExp(detail));
    assert.doesNotMatch(JSON.stringify(failure), /SECRET_SENTINEL/u);
  }
  for (const value of [null, {}, ""]) {
    assert.equal(publicMachineStartupFailure(value), undefined);
  }
});

test("a repository the Space's GitHub connection cannot reach is named, with what to check", () => {
  // The Hub's mint refusal, carried verbatim through the daemon's startup failure.
  const refusal = repositoryAccessUnavailableDetail("LambdaLabsHQ/xmatrix", "github_api_422");
  assert.equal(refusal, "repository_access_unavailable: the Space's GitHub connection cannot access LambdaLabsHQ/xmatrix (github_api_422)");
  const minted = publicMachineStartupFailure(
    `this Space's GitHub connector could not authorize LambdaLabsHQ/xmatrix (${refusal}) /private/SECRET_SENTINEL`);
  assert.equal(minted.code, "repository_access_unavailable");
  assert.match(minted.summary, /github_api_422/u);
  assert.match(minted.summary, /cannot access LambdaLabsHQ\/xmatrix/u);
  // GitHub refusing the fetch names no repository; the copy stays generic and
  // wins over a plain fetch failure.
  const fetched = publicMachineStartupFailure("repo pool lease unavailable (fetch_required_failed: repository_access_unavailable: GitHub refused the Space's credential (repository not found)) /private/SECRET_SENTINEL");
  assert.equal(fetched.code, "repository_access_unavailable");
  assert.match(fetched.summary, /repository not found/u);
  for (const failure of [minted, fetched]) assert.doesNotMatch(JSON.stringify(failure), /SECRET_SENTINEL|private/u);
  assert.doesNotMatch(repositoryAccessUnavailableDetail("../../etc", "x"), /\.\.\//u);
});

const rejected = "repo pool lease unavailable (fetch_required_failed: required origin fetch failed (From https://github.com/LambdaLabsHQ/xmatrix\n ! [rejected] main -> origin/main (non-fast-forward)))";

test("rejected fetch retains the exact cause and newlines with no invented advice", () => {
  const failure = publicMachineStartupFailure(rejected);
  assert.equal(failure.summary, rejected);
  assert.equal(failure.code, "repository_fetch_failed");
  assert.equal(failure.action, "");
});

test("all credentials are removed without losing subsequent diagnostic lines", () => {
  const raw = [
    "From https://u:URL_ONE@github.com/a/b?access_token=QUERY_ONE",
    "remote: https://u:URL_TWO@github.com/c/d#FRAGMENT_ONE",
    "Authorization: Bearer AUTH_ONE", "Cookie: session=COOKIE_ONE",
    "token=TOKEN_ONE password=PASSWORD_ONE token=TOKEN_TWO api_key=API_ONE",
    "ghp_GITHUB_ONE github_pat_GITHUB_TWO sk-OPENAI_ONE",
    "fatal: /home/private/LOCAL_ONE C:\\private\\LOCAL_TWO C:/private/LOCAL_THREE file:///home/private/LOCAL_FOUR",
    rejected,
  ].join("\n");
  const failure = publicMachineStartupFailure(raw);
  assert.doesNotMatch(failure.summary, /URL_ONE|URL_TWO|QUERY_ONE|FRAGMENT_ONE|AUTH_ONE|COOKIE_ONE|TOKEN_ONE|TOKEN_TWO|PASSWORD_ONE|API_ONE|GITHUB_ONE|GITHUB_TWO|OPENAI_ONE|LOCAL_ONE|LOCAL_TWO|LOCAL_THREE|LOCAL_FOUR/u);
  assert.ok(failure.summary.endsWith(rejected));
  assert.equal(publicMachineStartupFailure(failure.summary).summary, failure.summary);
});

test("bounds unicode diagnostics while leaving internal service errors to their existing boundary", () => {
  const failure = publicMachineStartupFailure("fatal: " + "😀".repeat(3_000));
  assert.equal(Array.from(failure.summary).length, 2_003);
  assert.ok(failure.summary.endsWith("..."));
});

test("quoted and truncated credentials cannot cross the Channel boundary", () => {
  for (const raw of ['{"token":"JSON_SECRET"}', "-----BEGIN RSA PRIVATE KEY-----\nKEY_SECRET\n", "Bearer HEADER_SECRET"]) {
    assert.doesNotMatch(publicMachineStartupFailure(raw).summary, /JSON_SECRET|KEY_SECRET|HEADER_SECRET/u);
  }
});
