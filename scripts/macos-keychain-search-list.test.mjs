import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
