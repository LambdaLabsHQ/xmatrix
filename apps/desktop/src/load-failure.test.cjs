const assert = require("node:assert/strict");
const test = require("node:test");

let isVisibleLoadFailure, loadFailurePage;
test.before(async () => {
  ({ isVisibleLoadFailure, loadFailurePage } = await import("./load-failure.ts"));
});

test("only a main-frame load that really failed replaces the window's page", () => {
  assert.equal(isVisibleLoadFailure(-106, true, "https://xmatrix.sh/app"), true);
  assert.equal(isVisibleLoadFailure(-3, true, "https://xmatrix.sh/app"), false);
  assert.equal(isVisibleLoadFailure(-106, false, "https://xmatrix.sh/app"), false);
  // The failure page itself never loops into another failure page.
  assert.equal(isVisibleLoadFailure(-106, true, "data:text/html,..."), false);
});

test("the failure page says what happened and returns to the page that failed", () => {
  const html = decodeURIComponent(loadFailurePage("https://xmatrix.sh/app/s/c?x=\"1\"", true, "#f5efe5").split(",").slice(1).join(","));
  assert.match(html, /You’re offline/u);
  assert.match(html, /Try again/u);
  assert.ok(html.includes(JSON.stringify("https://xmatrix.sh/app/s/c?x=\"1\"")));
  assert.match(decodeURIComponent(loadFailurePage("https://xmatrix.sh/app", false, "#f5efe5").split(",").slice(1).join(",")),
    /can’t be reached/u);
});
