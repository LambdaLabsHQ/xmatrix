const assert = require("node:assert/strict");
const test = require("node:test");

let desktopUpdateFeedUrl;
let desktopWebUrl;
let isDesktopWebOrigin;

test.before(async () => {
  ({ desktopUpdateFeedUrl, desktopWebUrl, isDesktopWebOrigin } = await import("./release-channel.ts"));
});

test("a desktop build follows the channel its own version names", () => {
  assert.equal(desktopUpdateFeedUrl("1.0.606-beta.3"), "https://xmatrix.sh/api/desktop/releases/dev");
  assert.equal(desktopUpdateFeedUrl("1.1.0"), "https://xmatrix.sh/api/desktop/releases/stable");
  assert.equal(desktopUpdateFeedUrl("1.1.0+build.7"), "https://xmatrix.sh/api/desktop/releases/stable");
});

test("a build loads and trusts only its own channel's Web, by exact origin", () => {
  // Plain http, other ports, the Hub, siblings and lookalikes of either Web.
  const neverTrusted = ["http://xmatrix.sh/app", "http://beta.xmatrix.sh/app", "https://xmatrix.sh:8443/app",
    "https://beta.xmatrix.sh:8443/app", "https://xmatrix-hub.xmatrix.sh/", "https://www.beta.xmatrix.sh/app",
    "https://beta.xmatrix.sh.evil.example/app", "https://xmatrix.sh.evil.example/app", "https://evilxmatrix.sh/app",
    "https://beta-xmatrix.sh/app"];
  const builds = [
    { version: "1.0.606-beta.3", opens: "https://beta.xmatrix.sh/app",
      trusts: ["https://beta.xmatrix.sh/app?channel=c1"], refuses: ["https://xmatrix.sh/app", "https://www.xmatrix.sh/app"] },
    { version: "1.1.0", opens: "https://xmatrix.sh/app",
      trusts: ["https://xmatrix.sh/app?channel=c1", "https://www.xmatrix.sh/login"], refuses: ["https://beta.xmatrix.sh/app"] },
  ];
  for (const { version, opens, trusts, refuses } of builds) {
    assert.equal(desktopWebUrl(version), opens);
    for (const page of [opens, ...trusts]) {
      assert.equal(isDesktopWebOrigin(new URL(page), version), true, `${version} trusts ${page}`);
    }
    for (const page of [...refuses, ...neverTrusted]) {
      assert.equal(isDesktopWebOrigin(new URL(page), version), false, `${version} refuses ${page}`);
    }
  }
});
