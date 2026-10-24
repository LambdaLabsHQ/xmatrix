const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const frames = fs.readFileSync(path.join(__dirname, "row-frames.ts"), "utf8");
const formatters = fs.readFileSync(path.join(__dirname, "workspace-shell-formatters.tsx"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../../app/globals.css"), "utf8");
const pageCss = fs.readFileSync(path.join(__dirname, "../../app/page-document.css"), "utf8");

test("channel prose uses a reading line-height and separates paragraphs and list items", () => {
  assert.match(frames, /text-\[15px\] leading-\[1\.75\]/);
  assert.match(frames, /RICH_MESSAGE_PARAGRAPH_CLASS_NAME = "mt-4 whitespace-pre-wrap first:mt-0"/);
  assert.match(formatters, /<ul className="mt-4 list-disc space-y-1 pl-5 first:mt-0">/);
  assert.match(formatters, /<ol start=\{start\} className="mt-4 list-decimal space-y-1 pl-5 first:mt-0">/);
  assert.match(css, /\.xmatrix-app \.rich-message li > p:first-of-type \{\s*margin-top: 0;\s*\}/);
  // Items 4px apart, and a nested list 4px below its item's text.
  assert.match(css, /\.xmatrix-app \.rich-message li > :is\(ul, ol\) \{\s*margin-top: 0\.25rem;\s*\}/);

  const lineHeights = [...css.matchAll(/\.rich-message \{[^}]*line-height:\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.deepEqual(lineHeights, ["1.75", "1.75"]);
});

test("page prose uses the same reading rhythm as channel messages", () => {
  assert.match(pageCss, /\.page-document \{\s*font-size: 15px;\s*line-height: 1\.75;/);
  assert.match(pageCss, /\.page-document > \* \+ \* \{ margin-top: 16px; \}/);
  assert.match(pageCss, /\.page-document li \+ li \{ margin-top: 4px; \}/);
  assert.match(pageCss, /\.page-document li > :is\(ul, ol\) \{ margin-top: 4px; \}/);
  assert.match(pageCss, /\.page-document \{ font-size: 16px; line-height: 1\.75; \}/);
  assert.equal(pageCss.match(/line-height: 1\.65/g), null);
});
