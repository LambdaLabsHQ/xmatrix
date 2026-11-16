const assert = require("node:assert/strict");
const test = require("node:test");

let deepLinkAppPath;

test.before(async () => {
  ({ deepLinkAppPath } = await import("./deep-link.ts"));
});

test("a connect returning from the browser lands on the app's own completion page with only its grant fields", () => {
  assert.equal(deepLinkAppPath("xmatrix://connect/oauth?state=s.sig&code=c%2F1&via=desktop&evil=1"), "/connect/oauth?state=s.sig&code=c%2F1");
  assert.equal(deepLinkAppPath("xmatrix://connect/oauth?code=c"), "/app");
  assert.equal(deepLinkAppPath("xmatrix://connect/oauth?state=a&state=b"), "/app");
  assert.equal(deepLinkAppPath("xmatrix://connect/elsewhere?state=a"), "/app");
});

test("channel and login links keep their places; anything else opens the app", () => {
  assert.equal(deepLinkAppPath("xmatrix://channel/abc%20d"), "/app?channel=abc%20d");
  assert.equal(deepLinkAppPath("xmatrix://login?token=1"), "/login?token=1");
  assert.equal(deepLinkAppPath("xmatrix://other"), "/app");
  assert.equal(deepLinkAppPath("https://example.com/connect/oauth?state=a"), "/app");
  assert.equal(deepLinkAppPath("not a url"), "/app");
});
