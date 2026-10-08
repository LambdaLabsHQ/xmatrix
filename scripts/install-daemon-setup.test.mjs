import { assert, spawnSync, fs, os, path, test, rootDir, finishDaemonHarness, assertExistingDaemonLogin } from "./script-test-fixture.mjs";
const installScript = fs.readFileSync(
  path.join(rootDir, "apps/web/public/install.sh"),
  "utf8",
);
const unixOnly = process.platform === "win32"
  ? { skip: "install.sh is verified by the Windows PowerShell harness" }
  : {};

/** Lifts one top-level `name() { ... }` definition out of install.sh. */
function shellFunction(name) {
  const lines = installScript.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  assert.notEqual(start, -1, `install.sh no longer defines ${name}()`);
  const end = lines.indexOf("}", start);
  assert.notEqual(end, -1, `install.sh has an unterminated ${name}()`);
  return lines.slice(start, end + 1).join("\n");
}

/**
 * Runs setup_daemon() against a fake xmatrix binary. `detached` puts the child
 * in its own session, which is what a cron job, CI runner, or daemon-spawned
 * install looks like: no controlling terminal, but /dev/tty still passes -r.
 */
function fakeXmatrix(loggedIn, loginFails = false) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-install-test-"));
  const callLog = path.join(workDir, "calls.log");
  const fakeBin = path.join(workDir, "xmatrix");

  fs.writeFileSync(
    fakeBin,
    [
      "#!/bin/sh",
      `echo "$@" >> "${callLog}"`,
      `[ "$1" = "whoami" ] && exit ${loggedIn === undefined || loggedIn ? 0 : 1}`,
      `[ "$1" = "login" ] && exit ${loginFails ? 1 : 0}`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return { workDir, callLog, fakeBin };
}

function runSetupDaemon({ osName = "macos", loggedIn = false, connect, loginFails = false } = {}) {
  const { workDir, callLog, fakeBin } = fakeXmatrix(loggedIn, loginFails);

  const harness = [
    "set -u",
    `OS_NAME="${osName}"`,
    ...(connect ? [`CONNECT_ID="${connect}"`] : []),
    'info() { echo "INFO: $*"; }',
    'step() { echo "STEP: $*"; }',
    'error() { echo "ERROR: $*"; }',
    'dim() { echo "DIM: $*"; }',
    'success() { echo "SUCCESS: $*"; }',
    "mark_done() { :; }",
    'install_daemon_autostart_macos() { echo "STARTUP_ENTRY_INSTALLED"; }',
    'install_daemon_autostart_linux() { echo "STARTUP_ENTRY_INSTALLED"; }',
    shellFunction("has_controlling_tty"),
    shellFunction("daemon_setup_supported"),
    shellFunction("setup_daemon"),
    `setup_daemon "${fakeBin}"`,
    "",
  ].join("\n");

  const result = spawnSync("bash", ["-c", harness], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  return finishDaemonHarness(workDir, callLog, result);
}

test("a session without a controlling terminal never starts a browser login", unixOnly, () => {
  const run = runSetupDaemon();

  assertExistingDaemonLogin(run);
  assert.match(run.stdout, /run 'xmatrix login' to finish setup/);
});

test("the daemon startup entry installs even when sign-in is deferred", unixOnly, () => {
  const run = runSetupDaemon();

  assert.match(run.stdout, /STARTUP_ENTRY_INSTALLED/);
});

test("an existing login is reused instead of prompting for a new one", unixOnly, () => {
  const run = runSetupDaemon({ loggedIn: true });

  assert.match(run.stdout, /Using the existing xMatrix login/);
  assert.doesNotMatch(run.calls, /login/);
  assert.match(run.stdout, /STARTUP_ENTRY_INSTALLED/);
});

test("a setup command signs in through its page even with a session, and a failure still installs", unixOnly, () => {
  const connected = runSetupDaemon({ loggedIn: true, connect: "0123456789abcdef0123456789abcdef" });
  assert.match(connected.calls, /^login --connect 0123456789abcdef0123456789abcdef$/m);
  assert.match(connected.stdout, /Approve this terminal on the xMatrix page/);
  assert.match(connected.stdout, /STARTUP_ENTRY_INSTALLED/);

  const failed = runSetupDaemon({ connect: "0123456789abcdef0123456789abcdef", loginFails: true });
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /Resume with: xmatrix login --connect 0123456789abcdef0123456789abcdef/);
  assert.match(failed.stdout, /STARTUP_ENTRY_INSTALLED/);
});

test("an unsupported platform skips daemon setup without touching the binary", unixOnly, () => {
  const run = runSetupDaemon({ osName: "windows" });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls, "");
  assert.doesNotMatch(run.stdout, /STARTUP_ENTRY_INSTALLED/);
  assert.match(run.stdout, /not supported for windows/);
});

/** Extract a top-level `name() { ... }` by brace depth so nested `if`/`case` is allowed. */
function extractFunction(name) {
  const lines = installScript.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  assert.notEqual(start, -1, `install.sh no longer defines ${name}()`);
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    const opens = (lines[i].match(/\{/g) || []).length;
    const closes = (lines[i].match(/\}/g) || []).length;
    depth += opens - closes;
    if (i > start && depth === 0) {
      return lines.slice(start, i + 1).join("\n");
    }
  }
  assert.fail(`install.sh has an unterminated ${name}()`);
}

function runInstallHelpers(scriptBody) {
  const result = spawnSync("bash", ["-c", scriptBody], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  return result;
}

test("the default install dir is always ~/.local/bin even when /usr/local/bin is on PATH", unixOnly, (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-install-dir-"));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const result = runInstallHelpers([
    "set -euo pipefail",
    `HOME=${JSON.stringify(workDir)}`,
    'PATH="/usr/local/bin:/usr/bin:/bin"',
    'LOGIN_PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"',
    extractFunction("default_install_dir"),
    'printf "%s\\n" "$(default_install_dir)"',
    "",
  ].join("\n"));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(workDir, ".local/bin"));
});

test("add_to_path writes an idempotent marked PATH block", unixOnly, () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-install-path-"));
  const profile = path.join(workDir, ".zprofile");
  const installDir = path.join(workDir, ".local/bin");
  const helpers = [
    extractFunction("path_line_for_profile"),
    extractFunction("append_path_block"),
    extractFunction("rewrite_path_block"),
    extractFunction("path_contains"),
    extractFunction("add_to_path"),
  ].join("\n");

  const runOnce = () => runInstallHelpers([
    "set -euo pipefail",
    `HOME=${JSON.stringify(workDir)}`,
    "SHELL=/bin/zsh",
    "PATH=/usr/bin:/bin",
    "LOGIN_PATH=/usr/bin:/bin",
    `INSTALL_DIR=${JSON.stringify(installDir)}`,
    "PATH_ACTION=already",
    "PATH_PROFILE=",
    "CONFLICT_PATH=",
    'pick_profile() { printf "%s\\n" "$HOME/.zprofile"; }',
    helpers,
    "add_to_path",
    'printf "action=%s\\n" "$PATH_ACTION"',
    `cat ${JSON.stringify(profile)}`,
    "",
  ].join("\n"));

  const first = runOnce();
  const second = runOnce();
  const body = fs.readFileSync(profile, "utf8");
  fs.rmSync(workDir, { recursive: true, force: true });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout, /action=added/);
  assert.match(second.stdout, /action=configured/);
  assert.match(body, /# >>> xMatrix installer >>>/);
  assert.ok(body.includes('export PATH="' + installDir + ':$PATH"'));
  assert.equal((body.match(/# >>> xMatrix installer >>>/g) || []).length, 1);
});

test("detect_conflicting_install warns about a PATH xmatrix that is not the user-owned copy", unixOnly, () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-install-conflict-"));
  const oldBinDir = path.join(workDir, "oldbin");
  const oldBin = path.join(oldBinDir, "xmatrix");
  fs.mkdirSync(oldBinDir, { recursive: true });
  fs.writeFileSync(oldBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const result = runInstallHelpers([
    "set -euo pipefail",
    `HOME=${JSON.stringify(workDir)}`,
    `PATH=${JSON.stringify(`${oldBinDir}:/usr/bin:/bin`)}`,
    "LOGIN_PATH=$PATH",
    "BIN_NAME=xmatrix",
    `INSTALL_DIR=${JSON.stringify(path.join(workDir, ".local/bin"))}`,
    "CONFLICT_PATH=",
    'BOLD="" DIM="" RESET=""',
    'info() { echo "INFO: $*"; }',
    'dim() { echo "DIM: $*"; }',
    extractFunction("lookup_existing_xmatrix"),
    extractFunction("detect_conflicting_install"),
    "detect_conflicting_install",
    'printf "conflict=%s\\n" "$CONFLICT_PATH"',
    "",
  ].join("\n"));
  fs.rmSync(workDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(`conflict=${oldBin}`), true, result.stdout);
  assert.match(result.stdout, /Detected existing/);
});

test("the daemon startup entry is registered by the binary, not generated in shell", unixOnly, () => {
  const { workDir, callLog, fakeBin } = fakeXmatrix();
  // The Linux path only checks that systemctl exists; the binary does the rest.
  fs.writeFileSync(path.join(workDir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const harness = [
    "set -u",
    `PATH="${workDir}:$PATH"`,
    'error() { echo "ERROR: $*"; }',
    shellFunction("install_daemon_autostart_macos"),
    shellFunction("install_daemon_autostart_linux"),
    `install_daemon_autostart_macos "${fakeBin}"`,
    `install_daemon_autostart_linux "${fakeBin}"`,
    "",
  ].join("\n");
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "";
  fs.rmSync(workDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls.trim().split("\n"),
    [`setup daemon --binary ${fakeBin}`, `setup daemon --binary ${fakeBin}`],
  );
  // The service definitions have exactly one home: the binary.
  assert.doesNotMatch(installScript, /xml_escape|daemon_path_unix|LaunchAgents|systemd\/user|<plist/u);
});

test("installer binds digest to the exact asset and rejects changed bytes", unixOnly, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-integrity-"));
  try {
    const file = path.join(dir, "candidate");
    fs.writeFileSync(file, "abc");
    const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const functions = [shellFunction("release_asset_metadata"), shellFunction("verify_release_asset")].join("\n");
    const run = (command, input = "") => spawnSync("bash", ["-c", `${functions}\n${command}`, "test", file, hash], { input, encoding: "utf8" });
    const metadata = { assets: [
      { name: "other", sha256: "f".repeat(64), size: 9, browser_download_url: "https://example.invalid/other" },
      { name: "wanted", sha256: hash, size: 3, browser_download_url: "https://example.invalid/wanted" },
    ] };
    const parsed = run("release_asset_metadata wanted", JSON.stringify(metadata));
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.equal(parsed.stdout.trim(), `https://example.invalid/wanted\t${hash}\t3`);
    metadata.assets.push(metadata.assets[1]);
    assert.notEqual(run("release_asset_metadata wanted", JSON.stringify(metadata)).status, 0);
    assert.equal(run('verify_release_asset "$1" "$2" 3').status, 0);
    assert.notEqual(run('verify_release_asset "$1" "$2" 4').status, 0);
    assert.notEqual(run('verify_release_asset "$1" invalid 3').status, 0);
    fs.writeFileSync(file, "abd");
    assert.notEqual(run('verify_release_asset "$1" "$2" 3').status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
