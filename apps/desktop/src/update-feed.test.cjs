const assert = require("node:assert/strict");
const test = require("node:test");

let desktopUpdateFeedUrl;

test.before(async () => {
  ({ desktopUpdateFeedUrl } = await import("./update-feed.ts"));
});

test("a desktop build follows the channel its own version names", () => {
  assert.equal(desktopUpdateFeedUrl("1.0.606-beta.3"), "https://xmatrix.sh/api/desktop/releases/dev");
  assert.equal(desktopUpdateFeedUrl("1.1.0"), "https://xmatrix.sh/api/desktop/releases/stable");
  assert.equal(desktopUpdateFeedUrl("1.1.0+build.7"), "https://xmatrix.sh/api/desktop/releases/stable");
});
