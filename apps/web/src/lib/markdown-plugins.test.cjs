const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

let Markdown;
let plugins;
test.before(async () => {
  Markdown = (await import("react-markdown")).default;
  plugins = (await import("./markdown-plugins.ts")).markdownRemarkPlugins;
});

function render(body) {
  return renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: plugins }, body));
}

test("the reported release URL excludes closing parentheses and Chinese prose", () => {
  const url = "https://github.com/LambdaLabsHQ/xmatrix/actions/runs/37120319572";
  for (const [open, close] of [["(", ")"], ["（", "）"]]) {
    const body = `PR #3440 已合并（main a5c7db43a）。已为 web 发起上线请求 ${open}${url}${close}，现在等发布流程跑完，完成后回报版本号和结果。`;
    assert.equal(render(body), `<p>PR #3440 已合并（main a5c7db43a）。已为 web 发起上线请求 ${open}<a href="${url}">${url}</a>${close}，现在等发布流程跑完，完成后回报版本号和结果。</p>`);
  }
});

test("CJK punctuation bounds protocol and www links without changing visible text", () => {
  for (const punctuation of "，。！？；：、（）［］【】《》〈〉「」『』“”‘’…") {
    const url = "https://example.com/path";
    assert.equal(render(`${url}${punctuation}后文`), `<p><a href="${url}">${url}</a>${punctuation}后文</p>`);
    assert.equal(render(`www.example.com/path${punctuation}后文`), `<p><a href="http://www.example.com/path">www.example.com/path</a>${punctuation}后文</p>`);
  }
});

test("following prose retains formatting, entities and additional links", () => {
  assert.equal(render("https://example.com/a，**完成**；https://example.org/b。结束"),
    '<p><a href="https://example.com/a">https://example.com/a</a>，<strong>完成</strong>；<a href="https://example.org/b">https://example.org/b</a>。结束</p>');
  assert.equal(render("https://example.com/a?x=1&amp;y=2，完成"),
    '<p><a href="https://example.com/a?x=1&amp;amp;y=2">https://example.com/a?x=1&amp;amp;y=2</a>，完成</p>');
  assert.equal(render("| 链接 |\n| --- |\n| https://example.com/a，完成 |"),
    '<table><thead><tr><th>链接</th></tr></thead><tbody><tr><td><a href="https://example.com/a">https://example.com/a</a>，完成</td></tr></tbody></table>');
});

test("explicit links and code preserve intentionally embedded punctuation", () => {
  const url = "https://example.com/路径，说明";
  const encoded = "https://example.com/%E8%B7%AF%E5%BE%84%EF%BC%8C%E8%AF%B4%E6%98%8E";
  assert.equal(render(`[${url}](${url})`), `<p><a href="${encoded}">${url}</a></p>`);
  assert.equal(render(`<${url}>`), `<p><a href="${encoded}">${url}</a></p>`);
  assert.equal(render(`[文档][ref]\n\n[ref]: ${url}`), `<p><a href="${encoded}">文档</a></p>`);
  assert.equal(render(`\`${url}\``), `<p><code>${url}</code></p>`);
  assert.equal(render(`\`\`\`text\n${url}\n\`\`\``), `<pre><code class="language-text">${url}\n</code></pre>`);
});

test("Unicode URLs, encoded punctuation and balanced parentheses remain valid", () => {
  const cases = [
    ["https://example.com/路径?q=中文#章节", "https://example.com/%E8%B7%AF%E5%BE%84?q=%E4%B8%AD%E6%96%87#%E7%AB%A0%E8%8A%82"],
    ["https://例子.测试/路径", "https://%E4%BE%8B%E5%AD%90.%E6%B5%8B%E8%AF%95/%E8%B7%AF%E5%BE%84"],
    ["https://example.com/a%EF%BC%8Cb", "https://example.com/a%EF%BC%8Cb"],
    ["https://example.com/wiki/Function_(math)", "https://example.com/wiki/Function_(math)"],
  ];
  for (const [url, href] of cases) {
    assert.equal(render(`${url}，完成`), `<p><a href="${href}">${url}</a>，完成</p>`);
  }
});

test("a dense run of adjacent links terminates without recursive traversal", () => {
  const url = "https://example.com/a";
  const count = 300;
  const html = render(Array(count).fill(url).join("，"));
  assert.equal((html.match(/<a /g) || []).length, count);
  assert.equal(html.replace(/<[^>]*>/g, ""), Array(count).fill(url).join("，"));
});
