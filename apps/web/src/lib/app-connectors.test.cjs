const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { groupConnectorsForList, orderConnectorsForList } = require("./app-connectors.ts");

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

test("the list groups apps by state, then lists unconnected apps once under their category", () => {
  const app = (id, name, kind, status = "available") => ({ id, name, kind, status });
  const groups = groupConnectorsForList([
    app("github", "GitHub", "code-host"),
    app("gitlab", "GitLab", "code-host"),
    app("circleci", "CircleCI", "ci"),
    app("slack", "Slack", "chat"),
    app("sentry", "Sentry", "observability"),
    app("linear", "Linear", "issue-tracker"),
    app("stripe", "Stripe", "billing"),
    app("acme", "Acme", "chat", "planned"),
  ], [
    { providerId: "sentry", status: "error" },
    { providerId: "github", status: "configured" },
    { providerId: "linear", status: "disconnected" },
  ]);
  assert.deepEqual(groups.map((group) => [group.title, group.connectors.map((item) => item.id)]), [
    ["Needs attention", ["sentry"]],
    ["Connected", ["github"]],
    ["Disconnected", ["linear"]],
    ["Code & CI", ["circleci", "gitlab"]],
    ["Chat", ["slack"]],
    ["More", ["stripe"]],
    ["Coming soon", ["acme"]],
  ]);
});
