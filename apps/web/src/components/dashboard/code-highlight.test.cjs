const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const hljs = require("highlight.js");
const { highlightCode } = require("./code-highlight.ts");

test("a fence's language colours it, and its markup stays escaped text", () => {
  const html = highlightCode(hljs, 'const page = "<img src=x onerror=alert(1)>";', "ts");
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
});

test("a fence without a language is coloured only when a grammar clearly claims it", () => {
  assert.match(highlightCode(hljs, '{\n  "productId": "sh.xmatrix.app.pro.annual",\n  "period": "ONE_YEAR",\n  "level": 1,\n  "ready": true\n}', ""), /hljs-/);
  const table = [
    "group        product id                     name                  period     level",
    "xMatrix Pro  sh.xmatrix.app.pro.annual      xMatrix Pro Annual    ONE_YEAR   1",
  ].join("\n");
  assert.equal(highlightCode(hljs, table, ""), null);
  assert.equal(highlightCode(hljs, "error: failed to connect to hub (timeout after 30s)\nretrying in 5s", ""), null);
});

test("a language no grammar knows stays plain ink", () => {
  assert.equal(highlightCode(hljs, "anything", "not-a-language"), null);
});
