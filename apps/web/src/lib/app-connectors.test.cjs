const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { orderConnectorsForList } = require("./app-connectors.ts");

const connector = (id, name, status = "available") => ({ id, name, status });

test("apps needing attention lead, then connected, disconnected, unconnected and coming soon, each by name", () => {
  const ordered = orderConnectorsForList([
    connector("x", "X"),
    connector("github", "GitHub"),
    connector("soon", "Acme", "coming_soon"),
    connector("bing", "Bing Webmaster Tools"),
    connector("gmail", "Gmail"),
    connector("feishu", "Feishu"),
    connector("appstore", "App Store Connect"),
    connector("yandex", "Yandex Webmaster"),
  ], [
    { providerId: "github", status: "configured" },
    { providerId: "gmail", status: "configured" },
    { providerId: "appstore", status: "configured" },
    { providerId: "bing", status: "error" },
    { providerId: "feishu", status: "disconnected" },
  ]);
  assert.deepEqual(ordered.map((item) => item.id),
    ["bing", "appstore", "github", "gmail", "feishu", "x", "yandex", "soon"]);
});

test("names compare without regard to case", () => {
  const ordered = orderConnectorsForList([connector("b", "beta"), connector("a", "Alpha"), connector("c", "Gamma")], []);
  assert.deepEqual(ordered.map((item) => item.id), ["a", "b", "c"]);
});
