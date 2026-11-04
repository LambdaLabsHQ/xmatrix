const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { isAppShellPath } = require("./app-shell-route.ts");

test("every shell address is served the prerendered workspace page", () => {
  for (const path of [
    "/app",
    "/app/space-1",
    "/app/space-1/pages",
    "/app/space-1/channels",
    "/app/space-1/channels/general--abc",
    "/app/space-1/settings",
    "/app/space-1/more",
  ]) assert.equal(isAppShellPath(path), true, path);
});

test("legacy redirects and unknown addresses keep their routes", () => {
  for (const path of [
    "/app/space-1/direct",
    "/app/space-1/roles",
    "/app/space-1/analytics",
    "/app/space-1/legacy-channel-id",
    "/app/space-1/pages/extra",
    "/app/space-1/channels/general/extra",
    "/app/space-1/channels/",
    "/app/",
    "/apps",
    "/workspace",
    "/login",
  ]) assert.equal(isAppShellPath(path), false, path);
});
