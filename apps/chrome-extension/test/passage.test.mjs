import assert from "node:assert/strict";
import test from "node:test";

import { pagePassage } from "../src/passage.js";
import { chromeVersion } from "../scripts/package.mjs";

test("a passage is bounded text from a web page with a known target", () => {
  assert.deepEqual(pagePassage({ text: " line\r\nnext ", title: "Issue\n  #12", url: "https://example.test/a", target: "new" }),
    { text: "line\nnext", label: "Issue #12", href: "https://example.test/a", target: "new" });
  assert.equal(pagePassage({ text: "x", title: "Settings", url: "chrome://settings", target: "new" }), null);
  assert.equal(pagePassage({ text: "x", title: "T", url: "javascript:alert(1)", target: "current" }), null);
  assert.equal(pagePassage({ text: "x", title: "T", url: "https://example.test", target: "all" }), null);
  assert.equal(pagePassage({ text: "y".repeat(30_000), title: "T", url: "https://example.test", target: "current" }).text.length, 20_000);
});

test("a beta release ships with a version Chrome accepts and its full name beside it", () => {
  assert.deepEqual(chromeVersion("4.7.3-beta.2"), { version: "4.7.3", versionName: "4.7.3-beta.2" });
  assert.deepEqual(chromeVersion("1.0.0"), { version: "1.0.0", versionName: "1.0.0" });
  assert.throws(() => chromeVersion("4.7"), /Not a release version/u);
});

test("an unpacked build opens the beta Web and the store build the stable Web", async () => {
  const { appOrigin } = await import("../src/hub-client.js");
  assert.equal(appOrigin({ key: "MIIB…" }), "https://beta.xmatrix.sh");
  assert.equal(appOrigin({}), "https://xmatrix.sh");
});
