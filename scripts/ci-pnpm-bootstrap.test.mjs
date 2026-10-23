import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";
import { readRepoFile } from "./script-test-fixture.mjs";

// Execute the release/CI bootstrap step at its shell boundary. No existing
// owner covers npm failing before PNPM is available; the observed reset must
// recover without retrying a permanent install failure or publishing no binary.
const step = parse(readRepoFile(".github/actions/setup-pnpm-node/action.yml"))
  .runs.steps.find(({ name }) => name === "Enable PNPM");

function bootstrap(t, codes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-pnpm-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RUNNER_TEMP/calls"
attempt=$(wc -l < "$RUNNER_TEMP/calls")
code=$(sed -n "$attempt"p "$RUNNER_TEMP/codes")
if [ -n "$code" ]; then
  echo "npm error code $code" >&2
  exit 152
fi
while [ "$1" != --prefix ]; do shift; done
mkdir -p "$2/bin"
printf '#!/usr/bin/env bash\\necho 11.3.0\\n' > "$2/bin/pnpm"
chmod +x "$2/bin/pnpm"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), `#!/usr/bin/env bash
printf '%s\\n' "$1" >> "$RUNNER_TEMP/delays"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, "codes"), codes.join("\n"));
  const githubPath = path.join(directory, "github-path");
  fs.writeFileSync(githubPath, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory, GITHUB_PATH: githubPath },
  });
  const lines = (file) => fs.existsSync(path.join(directory, file))
    ? fs.readFileSync(path.join(directory, file), "utf8").trim().split("\n").filter(Boolean) : [];
  return { result, calls: lines("calls"), delays: lines("delays"), published: lines("github-path"), directory };
}

const posix = { skip: process.platform === "win32" };

test("a bootstrap ECONNRESET retries the pinned install and publishes PNPM only after success", posix, (t) => {
  const { result, calls, delays, published, directory } = bootstrap(t, ["ECONNRESET", ""]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls).size, 1);
  assert.match(calls[0], /pnpm@11\.3\.0\b/);
  assert.deepEqual(delays, ["2"]);
  assert.deepEqual(published, [path.join(directory, "xmatrix-pnpm-11.3.0/bin")]);
  assert.match(result.stdout, /11\.3\.0/);
});

test("repeated network failures stop after three attempts and retain npm's failure status", posix, (t) => {
  const { result, calls, delays, published } = bootstrap(t, ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);
  assert.equal(result.status, 152, result.stderr + result.stdout);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, ["2", "4"]);
  assert.deepEqual(published, []);
});

test("a successful bootstrap needs one install and no backoff", posix, (t) => {
  const { result, calls, delays, published } = bootstrap(t, [""]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
  assert.equal(published.length, 1);
});

test("a permanent error after a reset stops before another attempt", posix, (t) => {
  const { result, calls, delays, published } = bootstrap(t, ["ECONNRESET", "EINTEGRITY", ""]);
  assert.equal(result.status, 152, result.stderr + result.stdout);
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, ["2"]);
  assert.deepEqual(published, []);
});

for (const code of ["E401", "E403", "E404", "EINTEGRITY", "EACCES", "ENOSPC", "ELIFECYCLE"]) {
  test(`${code} fails without retry or PATH publication`, posix, (t) => {
    const { result, calls, delays, published } = bootstrap(t, [code]);
    assert.equal(result.status, 152, result.stderr + result.stdout);
    assert.equal(calls.length, 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(published, []);
  });
}
