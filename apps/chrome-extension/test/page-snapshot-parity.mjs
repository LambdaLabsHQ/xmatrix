#!/usr/bin/env node
// Compares the page an Agent reads (src/page-snapshot.js) with Playwright's own `locator.ariaSnapshot()` on real
// pages, line for line: run it after moving snapshot/playwright to a newer Playwright.
//
//   node test/page-snapshot-parity.mjs https://developer.mozilla.org/en-US/docs/Web/HTML/Element/table …
//
// It drives Chromium with apps/web's Playwright, a test tool only: the extension itself runs none of it.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { buildPageSnapshot } from "../scripts/package.mjs";

const { chromium } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
const urls = process.argv.slice(2);
if (!urls.length) {
  console.error("Name the pages to compare: node test/page-snapshot-parity.mjs <url>…");
  process.exit(2);
}
const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "page-snapshot-")), "page-snapshot.js");
await buildPageSnapshot(script);
const browser = await chromium.launch();
let differing = 0;
try {
  const page = await browser.newPage();
  for (const url of urls) {
    await page.goto(url, { waitUntil: "networkidle" }).catch(() => undefined);
    // As the extension's executeScript does, past the page's own content security policy.
    await page.evaluate(fs.readFileSync(script, "utf8"));
    // A live page (an ad, a lazy section) can change between the two reads: a difference must hold twice.
    let theirs = "", ours = "", same = false;
    for (let attempt = 0; attempt < 2 && !same; attempt++) {
      if (attempt) await page.waitForTimeout(2000);
      theirs = await page.locator("body").ariaSnapshot();
      ours = await page.evaluate(() => globalThis.__xmatrixPageSnapshot(Number.MAX_SAFE_INTEGER));
      same = theirs === ours;
    }
    if (!same) differing += 1;
    console.log(`${same ? "same" : "DIFFERENT"}  ${theirs.split("\n").length} lines  ${url}`);
  }
} finally {
  await browser.close();
}
process.exit(differing ? 1 : 0);
