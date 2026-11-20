import assert from "node:assert/strict";
import test from "node:test";

import { composeMessage } from "../src/compose.js";
import { chromeVersion } from "../scripts/package.mjs";

test("the note comes first, then the page link, then the selection as a quote", () => {
  assert.equal(
    composeMessage({
      note: "@claude look at this",
      title: "Issue [#12]\n  crash",
      url: "https://example.test/a?b=1",
      selection: "line one\n\nline two",
    }),
    "@claude look at this\n\n[Issue #12 crash](https://example.test/a?b=1)\n\n> line one\n>\n> line two",
  );
});

test("pages that are not on the web, or left out, send only the note", () => {
  assert.equal(composeMessage({ note: "hi", title: "Settings", url: "chrome://settings", selection: "x" }), "hi");
  assert.equal(composeMessage({ note: "hi", title: "T", url: "https://example.test", selection: "x", includePage: false }), "hi");
  assert.equal(composeMessage({ note: " ", url: "javascript:alert(1)" }), "");
});

test("a beta release ships with a version Chrome accepts and its full name beside it", () => {
  assert.deepEqual(chromeVersion("4.7.3-beta.2"), { version: "4.7.3", versionName: "4.7.3-beta.2" });
  assert.deepEqual(chromeVersion("1.0.0"), { version: "1.0.0", versionName: "1.0.0" });
  assert.throws(() => chromeVersion("4.7"), /Not a release version/u);
});
