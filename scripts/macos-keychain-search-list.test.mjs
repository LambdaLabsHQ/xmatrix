import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(rootDir, "scripts", "macos-keychain-search-list.sh");
const signingWorkflows = [
  ".github/workflows/cli-build.yml",
  ".github/workflows/desktop-release.yml",
  ".github/workflows/ios-testflight.yml",
].map((file) => fs.readFileSync(path.join(rootDir, file), "utf8"));

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-keychain-list-"));
  const state = path.join(directory, "search-list.txt");
  const security = path.join(directory, "security");
  const signingKeychain = path.join(directory, "signing.keychain-db");

  fs.writeFileSync(signingKeychain, "fixture");
  fs.writeFileSync(
    security,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 3 ] && [ "$1" = "list-keychains" ] && [ "$2" = "-d" ] && [ "$3" = "user" ]; then
  /bin/cat "$FAKE_KEYCHAIN_STATE"
  exit 0
fi
if [ "$#" -ge 5 ] && [ "$1" = "list-keychains" ] && [ "$2" = "-d" ] && [ "$3" = "user" ] && [ "$4" = "-s" ]; then
  : > "$FAKE_KEYCHAIN_STATE"
  shift 4
  for keychain in "$@"; do
    printf '    "%s"\\n' "$keychain" >> "$FAKE_KEYCHAIN_STATE"
  done
  exit 0
fi
echo "unexpected security invocation: $*" >&2
exit 64
`,
    { mode: 0o755 },
  );

  return { directory, security, signingKeychain, state };
}

function runHelper(fixture, action) {
  return spawnSync("/bin/bash", [helper, action, fixture.signingKeychain], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_KEYCHAIN_STATE: fixture.state,
      XMATRIX_KEYCHAIN_SEARCH_LIST_LOCKED: "1",
      XMATRIX_SECURITY_BIN: fixture.security,
    },
  });
}

function hasUnixBash() {
  // Helper is a bash script with lockf; spawnSync("/bin/bash") is null on Windows.
  return process.platform !== "win32" && fs.existsSync("/bin/bash");
}

function keychainFixture(t) {
  if (!hasUnixBash()) {
    t.skip("requires /bin/bash (macOS/Linux signing hosts only)");
    return null;
  }
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  return fixture;
}

function assertKeychainState(result, fixture, loginKeychain, message) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(fixture.state, "utf8"),
    `    "${fixture.signingKeychain}"\n    "${loginKeychain}"\n`, message);
}

test("macOS signing Keychain updates preserve valid user search entries", (t) => {
  const fixture = keychainFixture(t);
  if (!fixture) return;
  const loginKeychain = "/Users/example/Library/Keychains/login.keychain-db";
  fs.writeFileSync(fixture.state, `    "${loginKeychain}"\n`);

  let result = runHelper(fixture, "add");
  assertKeychainState(result, fixture, loginKeychain);

  result = runHelper(fixture, "add");
  assertKeychainState(result, fixture, loginKeychain, "adding the same signing Keychain must not duplicate it");

  result = runHelper(fixture, "remove");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(fixture.state, "utf8"), `    "${loginKeychain}"\n`);
});

test("macOS signing Keychain updates reject the corruption shape", (t) => {
  const fixture = keychainFixture(t);
  if (!fixture) return;
  const corrupted =
    '    "/Users/example/Library/Keychains/    "/tmp/old-signing.keychain-db"\n';
  fs.writeFileSync(fixture.state, corrupted);

  const result = runHelper(fixture, "add");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing malformed Keychain search-list entry/);
  assert.equal(fs.readFileSync(fixture.state, "utf8"), corrupted);
});

test("every macOS signing workflow uses the bounded search-list transaction", () => {
  const preparation = fs.readFileSync(path.join(rootDir, "scripts", "macos-signing-keychain.sh"), "utf8");
  assert.match(preparation, /macos-keychain-search-list\.sh add/);
  assert.doesNotMatch(preparation, /security list-keychains -d user -s/);
  for (const workflow of signingWorkflows) {
    if (workflow.includes("source scripts/macos-signing-keychain.sh")) {
      assert.match(workflow, /prepare_developer_id_keychain "\$certificate" "\$intermediate" "\$keychain" "\$keychain_password"/);
    } else {
      assert.match(workflow, /macos-keychain-search-list\.sh add/);
    }
    assert.match(workflow, /macos-keychain-search-list\.sh remove/);
    assert.doesNotMatch(workflow, /security list-keychains -d user -s/);
  }
});

test("CLI release serialization follows shared macOS hosts, not isolated hosted VMs", () => {
  // The transaction tests above protect mutations inside a signing host. This
  // release-workflow boundary protects scheduling: shared hosts serialize,
  // while isolated hosted VMs must not wait for one another's entire build.
  const { concurrency, strategy } = parse(signingWorkflows[0]).jobs.build;
  const expression = concurrency.group.match(/\$\{\{\s*([\s\S]*?)\s*\}\}/u)[1];
  const evaluate = new Function("vars", "matrix", "github", "contains", "format", `return (${expression});`);
  const group = (target, fleet, runId) => evaluate(
    { XMATRIX_RUNNER_FLEET: fleet }, { target }, { run_id: runId },
    (value, search) => value.includes(search),
    (template, ...values) => template.replace(/\{(\d+)\}/gu, (_, index) => values[Number(index)]),
  );
  const targets = strategy.matrix.include.map(({ target }) => target);
  assert.equal(concurrency["cancel-in-progress"], false);
  for (const fleet of [undefined, "github-hosted"]) {
    const groups = targets.flatMap((target) => [group(target, fleet, 1), group(target, fleet, 2)]);
    assert.equal(new Set(groups).size, groups.length, "hosted builds must all be independent");
  }
  const macTargets = targets.filter((target) => target.includes("apple-darwin"));
  assert.equal(macTargets.length, 2);
  assert.equal(group(macTargets[0], "self-hosted", 1), group(macTargets[1], "self-hosted", 2),
    "shared macOS keychains need serialization across architectures and release runs");
  const nativeGroups = targets.filter((target) => !macTargets.includes(target))
    .map((target) => group(target, "self-hosted", 1));
  assert.equal(new Set(nativeGroups).size, nativeGroups.length);
  assert.ok(nativeGroups.every((value) => value !== group(macTargets[0], "self-hosted", 1)));
});
