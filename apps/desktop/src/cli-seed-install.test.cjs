const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

let seedInstall;

test.before(async () => {
  seedInstall = await import("./cli-seed-install.ts");
});

test("the seed lives under Resources/cli with the platform's binary name", () => {
  assert.equal(
    seedInstall.desktopCliSeedPath({ resourcesPath: "/Applications/xMatrix.app/Contents/Resources", platform: "darwin" }),
    path.join("/Applications/xMatrix.app/Contents/Resources", "cli", "xmatrix"),
  );
  assert.equal(
    seedInstall.desktopCliSeedPath({ resourcesPath: "C:\\Program Files\\xMatrix\\resources", platform: "win32" }),
    path.join("C:\\Program Files\\xMatrix\\resources", "cli", "xmatrix.exe"),
  );
});

test("the seed always asks the binary to register the daemon", () => {
  assert.deepEqual(
    seedInstall.cliSeedInstallArgs("/seed/xmatrix", "darwin"),
    ["setup", "install", "--from", "/seed/xmatrix", "--daemon", "--json"],
  );
  assert.deepEqual(
    seedInstall.cliSeedInstallArgs("C:\\seed\\xmatrix.exe", "win32"),
    ["setup", "install", "--from", "C:\\seed\\xmatrix.exe", "--daemon", "--json"],
  );
});

test("a build without a seed reports no-seed instead of running anything", async () => {
  let invoked = false;
  const result = await seedInstall.installCliFromSeed({
    seedPath: "/nowhere/cli/xmatrix",
    env: {},
    platform: "darwin",
    exists: () => false,
    execFileImpl: () => { invoked = true; },
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "no-seed",
    message: "This build of xMatrix does not include a CLI seed (/nowhere/cli/xmatrix).",
  });
  assert.equal(invoked, false);
});

test("the seed's JSON report becomes the install result", async () => {
  const calls = [];
  const result = await seedInstall.installCliFromSeed({
    seedPath: "/seed/xmatrix",
    env: { PATH: "/usr/bin" },
    platform: "darwin",
    exists: () => true,
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, timeout: options.timeout, windowsHide: options.windowsHide });
      callback(null, [
        "noise before the report",
        JSON.stringify({
          installedPath: "/Users/me/.local/bin/xmatrix",
          version: "xmatrix 0.16.281",
          daemon: { manager: "launchd", definitionPath: "/Users/me/Library/LaunchAgents/sh.xmatrix.daemon.plist" },
        }),
        "",
      ].join("\n"), "");
    },
  });
  assert.deepEqual(calls, [{
    file: "/seed/xmatrix",
    args: ["setup", "install", "--from", "/seed/xmatrix", "--daemon", "--json"],
    timeout: 120_000,
    windowsHide: true,
  }]);
  assert.deepEqual(result, {
    ok: true,
    installedPath: "/Users/me/.local/bin/xmatrix",
    version: "xmatrix 0.16.281",
    daemon: { manager: "launchd", definitionPath: "/Users/me/Library/LaunchAgents/sh.xmatrix.daemon.plist" },
  });
});

test("a failing seed surfaces its stderr and a silent one is not mistaken for success", async () => {
  const failed = await installLinuxSeed((_file, _args, _options, callback) => callback(new Error("exit 1"), "", "Error: seed binary did not report a version\n"));
  assert.deepEqual(failed, { ok: false, reason: "install-failed", message: "Error: seed binary did not report a version" });

  const silent = await installLinuxSeed((_file, _args, _options, callback) => callback(null, "installed, but no report\n", ""));
  assert.deepEqual(silent, { ok: false, reason: "install-failed", message: "The xMatrix CLI seed did not report an install result." });
});

function installLinuxSeed(execFileImpl) {
  return seedInstall.installCliFromSeed({
    seedPath: "/seed/xmatrix", env: {}, platform: "linux", exists: () => true, execFileImpl,
  });
}
