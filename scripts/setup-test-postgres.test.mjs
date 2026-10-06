import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = readFileSync(new URL("./setup-test-postgres.sh", import.meta.url), "utf8");

test("test PostgreSQL bootstrap pins source and verifies before extracting or building", () => {
  assert.match(script, /postgres_version=17\.11/);
  assert.match(script, /postgres_sha256=5367f6fb2ec97efe1eb2e0c7926bb33438e51b0bd3a9733b88498056a7dc9a7e/);
  const checksum = script.indexOf("sha256sum --check --strict");
  const extract = script.indexOf("tar --extract");
  const configure = script.indexOf("./configure");
  assert.ok(checksum > 0 && extract > checksum && configure > extract);
  assert.equal(spawnSync("bash", ["-n", new URL("./setup-test-postgres.sh", import.meta.url).pathname]).status, 0);
});

test("missing decompressor enters isolated dependency preparation before any source request", () => {
  const directory = mkdtempSync(join(tmpdir(), "xmatrix-postgres-compression-test-"));
  try {
    // Controlled shell boundary: emulate Linux and a missing gzip, while
    // stopping before package/network access. No actual apt or curl is run.
    const shellFixture = join(directory, "shell-fixture.sh");
    writeFileSync(shellFixture, `
uname() { printf 'Linux\\n'; }
command() {
  if [[ "$1" == -v ]]; then
    case "$2" in
      gzip) return 1 ;;
      bison|flex|m4|make) return 0 ;;
    esac
  fi
  builtin command "$@"
}
apt-get() { printf 'fixture-isolated-apt %s\\n' "$*"; return 47; }
curl() { printf 'unexpected-source-download\\n'; return 48; }
`);
    const result = spawnSync("bash", [new URL("./setup-test-postgres.sh", import.meta.url).pathname], {
      env: { ...process.env, BASH_ENV: shellFixture, RUNNER_TEMP: directory, GITHUB_ENV: join(directory, "env") },
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 47, result.stderr);
    assert.match(result.stdout, /fixture-isolated-apt .*Dir::State::lists=.*parser-tools\/apt-lists.*update/);
    assert.doesNotMatch(result.stdout, /unexpected-source-download/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared Hub CI provisions the toolchain before the mandatory full suite", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const hub = workflow.slice(workflow.indexOf("\n  hub:"), workflow.indexOf("\n  desktop:"));
  assert.match(hub, /timeout-minutes: 15/);
  const bootstrap = hub.indexOf("bash scripts/setup-test-postgres.sh");
  assert.ok(bootstrap >= 0 && bootstrap < hub.indexOf("run: node scripts/ci.mjs "));
  assert.doesNotMatch(hub, /continue-on-error/);
});

test("a verified cache entry is reused without any download or build", () => {
  const directory = mkdtempSync(join(tmpdir(), "xmatrix-postgres-cache-test-"));
  try {
    const shellFixture = join(directory, "shell-fixture.sh");
    writeFileSync(shellFixture, `
uname() { if [[ "$1" == -m ]]; then printf 'x86_64\\n'; else printf 'Linux\\n'; fi; }
curl() { printf 'unexpected-source-download\\n'; return 48; }
apt-get() { printf 'unexpected-apt\\n'; return 47; }
`);
    const cacheRoot = join(directory, "cache");
    const probe = spawnSync("bash", ["-c", `source ${JSON.stringify(shellFixture)}; ${
      script.split("\n").filter((line) => /^postgres_(version|sha256|configure_flags|cache_root|cache_key|cache_entry)=/.test(line)).join("\n")
    }; printf '%s' "$postgres_cache_entry"`], {
      env: { ...process.env, XMATRIX_TEST_POSTGRES_CACHE: cacheRoot }, encoding: "utf8",
    });
    const entry = probe.stdout;
    assert.ok(entry.startsWith(cacheRoot), probe.stderr);
    const bin = join(entry, "bin");
    spawnSync("mkdir", ["-p", bin]);
    for (const tool of ["initdb", "pg_ctl", "createdb", "psql"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} (PostgreSQL) 17.11"\n`, { mode: 0o755 });
    }
    writeFileSync(join(entry, ".complete"), "fixture\n");
    const githubEnv = join(directory, "env");
    const result = spawnSync("bash", [new URL("./setup-test-postgres.sh", import.meta.url).pathname], {
      env: { ...process.env, BASH_ENV: shellFixture, RUNNER_TEMP: directory, GITHUB_ENV: githubEnv,
        XMATRIX_TEST_POSTGRES_CACHE: cacheRoot },
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.doesNotMatch(result.stdout, /unexpected-/);
    assert.equal(readFileSync(githubEnv, "utf8"), `XMATRIX_TEST_POSTGRES_BIN=${bin}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
