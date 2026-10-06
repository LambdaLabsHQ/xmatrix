import { assert, spawnSync, fs, os, path, test, rootDir, finishDaemonHarness, assertExistingDaemonLogin } from "./script-test-fixture.mjs";
const installScript = fs.readFileSync(
  path.join(rootDir, "apps/web/public/install.ps1"),
  "utf8",
);
const mainMarker = "# ── Main ──────────────────────────────────────────────";
const mainMarkerIndex = installScript.indexOf(mainMarker);
assert.notEqual(mainMarkerIndex, -1, "install.ps1 no longer marks its main entrypoint");
const installPrelude = installScript.slice(0, mainMarkerIndex);
const windowsOnly = process.platform === "win32"
  ? {}
  : { skip: "install.ps1 runs only on Windows" };

function powerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runDaemonSetup({ loggedIn = false } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-install-windows-test-"));
  const callLog = path.join(workDir, "calls.log");
  const fakeBin = path.join(workDir, "xmatrix.cmd");
  const harness = path.join(workDir, "daemon-setup-harness.ps1");

  fs.writeFileSync(
    fakeBin,
    [
      "@echo off",
      `echo %*>>"${callLog}"`,
      `if /I "%~1"=="whoami" exit /b ${loggedIn ? 0 : 1}`,
      "exit /b 0",
      "",
    ].join("\r\n"),
  );

  const script = [
    installPrelude,
    "function Test-DaemonTaskStartup { param([string]$DaemonPath) return $true }",
    "function Mark-Done { param([int]$N = 1) }",
    `Start-DaemonSetup -InstallPath ${powerShellLiteral(fakeBin)}`,
    "",
  ].join("\r\n");
  fs.writeFileSync(harness, `\uFEFF${script}`, "utf8");

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness],
    { encoding: "utf8" },
  );
  return finishDaemonHarness(workDir, callLog, result);
}

test("PowerShell daemon setup reuses an existing login", windowsOnly, () => {
  const run = runDaemonSetup({ loggedIn: true });

  assertExistingDaemonLogin(run);
  assert.match(run.calls, /setup daemon --binary/);
  assert.match(run.stdout, /Existing xMatrix login verified/);
});

function windowsSessionIsInteractive() {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "[Environment]::UserInteractive"],
    { encoding: "utf8" },
  );
  return result.stdout.trim() === "True";
}

test("PowerShell daemon setup signs in before installing the startup entry", windowsOnly, () => {
  const run = runDaemonSetup();

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.calls, /whoami/);
  assert.match(run.calls, /setup daemon --binary/);
  // A service runner has no desktop. install.ps1 must not block that session
  // on a browser login; an interactive session still signs in first.
  if (windowsSessionIsInteractive()) {
    assert.match(run.calls, /login/);
    assert.match(run.stdout, /Browser sign-in is required before starting the daemon/);
  } else {
    assert.doesNotMatch(run.calls, /login/);
    assert.match(run.stdout, /No interactive session for sign-in/);
  }
});

test("installer rejects changed bytes before running the candidate", windowsOnly, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-integrity-"));
  try {
    const file = path.join(dir, "candidate.bin");
    const script = path.join(dir, "verify.ps1");
    fs.writeFileSync(file, "abc");
    fs.writeFileSync(script, `${installPrelude}\n$ErrorActionPreference = 'Stop'\n$asset = @{ size = 3; sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }\nAssert-ReleaseAssetIntegrity $asset ${powerShellLiteral(file)}\n[IO.File]::WriteAllText(${powerShellLiteral(file)}, 'abd')\ntry { Assert-ReleaseAssetIntegrity $asset ${powerShellLiteral(file)} } catch { exit 0 }\nexit 1\n`);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
