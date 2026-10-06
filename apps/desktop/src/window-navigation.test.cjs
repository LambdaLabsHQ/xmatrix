const assert = require("node:assert/strict");
const test = require("node:test");

let planWindowOpen;

test.before(async () => {
    ({ planWindowOpen } = await import("./window-navigation.ts"));
});

test("opens web links in the system browser, including xMatrix pages", () => {
  assert.deepEqual(planWindowOpen("https://xmatrix.sh/docs"), {
    kind: "external",
    url: "https://xmatrix.sh/docs",
  });
  assert.deepEqual(planWindowOpen("https://example.com/path?q=1"), {
    kind: "external",
    url: "https://example.com/path?q=1",
  });
  assert.deepEqual(planWindowOpen("mailto:support@xmatrix.sh"), {
    kind: "external",
    url: "mailto:support@xmatrix.sh",
  });
});

test("denies app deep links, unsafe protocols, and malformed targets", () => {
  assert.deepEqual(planWindowOpen("xmatrix://channel/example"), { kind: "deny" });
  assert.deepEqual(planWindowOpen("javascript:alert(1)"), { kind: "deny" });
  assert.deepEqual(planWindowOpen("/relative-path"), { kind: "deny" });
});
