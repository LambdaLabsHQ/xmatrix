import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseIdentifiers, scanText } from "./deny-scan.mjs";

const script = new URL("./deny-scan.mjs", import.meta.url).pathname;

test("identifiers match case-insensitively and findings never repeat them", () => {
  const findings = scanText("a.md", "Host: DEPLOY.Example.internal", ["deploy.example.internal"]);
  assert.deepEqual(findings, [{ file: "a.md", kind: "deployment identifier", value: "dep…(23)" }]);
});

test("credentials are refused without any identifier list", () => {
  const key = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");
  const [finding] = scanText("b.ts", `const key = "${key}";`, []);
  assert.equal(finding.kind, "Stripe live key");
  assert.equal(finding.value.includes(key), false);
});

test("identifier lists parse from JSON or lines and refuse values short enough to match anywhere", () => {
  assert.deepEqual(parseIdentifiers('["alpha-host", "beta-host"]'), ["alpha-host", "beta-host"]);
  assert.deepEqual(parseIdentifiers("alpha-host\n\n beta-host \n"), ["alpha-host", "beta-host"]);
  assert.deepEqual(parseIdentifiers(""), []);
  assert.throws(() => parseIdentifiers('["abc"]'), /shorter than 6/u);
});

test("the CLI scans tracked files and fails closed without identifiers when required", () => {
  const root = mkdtempSync(join(tmpdir(), "deny-scan-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "clean.md"), "nothing here\n");
    writeFileSync(join(root, "leak.md"), "see private-host-01\n");
    writeFileSync(join(root, "untracked.md"), "private-host-01\n");
    execFileSync("git", ["add", "clean.md", "leak.md"], { cwd: root });
    const run = (env) => {
      try {
        return { status: 0, out: execFileSync(process.execPath, [script, root], { env: { ...process.env, ...env }, encoding: "utf8", stdio: "pipe" }) };
      } catch (error) {
        return { status: error.status, out: `${error.stdout}${error.stderr}` };
      }
    };
    const leaked = run({ XMATRIX_DENY_IDENTIFIERS: '["private-host-01"]' });
    assert.equal(leaked.status, 1);
    assert.match(leaked.out, /leak\.md: deployment identifier pri…\(15\)/u);
    assert.doesNotMatch(leaked.out, /untracked\.md|private-host-01/u);
    assert.equal(run({ XMATRIX_DENY_IDENTIFIERS: '["other-host-02"]' }).status, 0);
    assert.notEqual(run({ XMATRIX_DENY_IDENTIFIERS: "", XMATRIX_DENY_REQUIRE_IDENTIFIERS: "true" }).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
