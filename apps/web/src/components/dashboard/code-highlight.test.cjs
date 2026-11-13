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

test("a Norn program shows who is asked, what is asked and the outcomes it handles", () => {
  hljs.registerLanguage("norn", require("./norn-grammar.ts").default);
  const html = highlightCode(hljs, `// review
type verdict = Sound | Flawed(string)
switch run(@codex, "Find what does not hold", ~about=draft, ~by=30m)->wait {
| Answered(Sound) => true
| other => fail(other)
}`, "norn");
  for (const ink of ['<span class="hljs-comment">// review</span>', '<span class="hljs-keyword">switch</span>',
    '<span class="hljs-built_in">run</span>', '<span class="hljs-title">@codex</span>', '<span class="hljs-attr">~about</span>',
    '<span class="hljs-number">30m</span>', '<span class="hljs-built_in">wait</span>', '<span class="hljs-type">Answered</span>',
    '<span class="hljs-literal">true</span>', '<span class="hljs-string">&quot;Find what does not hold&quot;</span>']) {
    assert.ok(html.includes(ink), `${ink} in ${html}`);
  }
});

test("a Norn moment is one ink", () => {
  hljs.registerLanguage("norn", require("./norn-grammar.ts").default);
  const html = highlightCode(hljs, "after(2027-06-04T00:00Z)->wait\nevery(1d, ~from=2026-11-03)->forEach(_ => say(@Daniel, \"hi\"))", "norn");
  assert.ok(html.includes('<span class="hljs-number">2027-06-04T00:00Z</span>)-&gt;'), html);
  assert.ok(html.includes('<span class="hljs-number">2026-11-03</span>'), html);
});
