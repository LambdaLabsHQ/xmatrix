const { readDashboardSource } = require("./source-scan-fixture.cjs");
const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");

const { extractFunctionSource } = require("./workspace-shell-source-fixture.cjs");

// The Agents screen was the `roles` view until Roles were retired. Published
// iOS builds and bookmarks still name it `roles`, so that name
// keeps opening Agents while the canonical address is `agents`.
const navigationSource = readDashboardSource("workspace-shell-navigation.ts");
const pathSource = readDashboardSource("workspace-shell-path.ts");
const pick = (source, name) => extractFunctionSource(source, name, { fileName: "module.ts" });
const moduleSource = [
  pick(pathSource, "decodePathSegment"),
  pick(navigationSource, "parseAppLocation"),
  pick(navigationSource, "pagesViewSelection"),
  pick(navigationSource, "LEGACY_VIEW_SEGMENTS"),
  pick(navigationSource, "isAppView"),
  pick(navigationSource, "viewForRouteSegment"),
  pick(navigationSource, "appRouteInfo"),
  "module.exports = { appRouteInfo, viewForRouteSegment, isAppView };",
].join("\n").replace(/^export /gm, "").replace(/: Record<string, AppView>/, "");
const { appRouteInfo, viewForRouteSegment, isAppView } = new Function(
  "module",
  `${ts.transpileModule(moduleSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nreturn module.exports;`,
)({ exports: {} });

test("agents is the canonical Agents view and roles is only a legacy alias", () => {
  assert.equal(isAppView("agents"), true);
  assert.equal(isAppView("roles"), false);
  assert.equal(viewForRouteSegment("agents"), "agents");
  assert.equal(viewForRouteSegment("roles"), "agents");
  assert.equal(appRouteInfo("/app/lambda/agents").view, "agents");
  assert.equal(appRouteInfo("/app/lambda/roles?item=abc").view, "agents");
  assert.equal(appRouteInfo("/app?view=roles").view, "agents");
  assert.equal(appRouteInfo("/app?view=agents").view, "agents");
});

test("every native iOS tab names a web view the router recognizes", () => {
  const swift = readDashboardSource("../../../../ios/xMatrix/MobileTabBarView.swift");
  const tabEnum = swift.slice(swift.indexOf("enum MobileTabView"), swift.indexOf("var label"));
  const rawValues = [...tabEnum.matchAll(/case \w+ = "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rawValues, ["pages", "messages", "agents", "more"]);
  for (const view of rawValues) assert.equal(isAppView(view), true, view);
});
