const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { machineOs } = require("./machine-os.ts");

test("a Machine's OS comes from the reported platform, never inferred", () => {
  // Daemon metadata uses `windows` / `macos` / `linux`; the desktop bridge uses Node names.
  assert.equal(machineOs("windows"), "windows");
  assert.equal(machineOs("win32"), "windows");
  assert.equal(machineOs("macos"), "macos");
  assert.equal(machineOs("darwin"), "macos");
  assert.equal(machineOs("linux"), "linux");
});

test("an unknown or missing platform stays unknown", () => {
  for (const platform of [undefined, "", "freebsd", "ios", "android"]) {
    assert.equal(machineOs(platform), "unknown");
  }
});
