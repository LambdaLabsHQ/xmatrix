// Draws the card a shared link to the site shows (og:image; `shareImage` in src/lib/site-url.ts):
//   node scripts/share-card.mjs
// writes public/brand/xmatrix-share-card.jpg, 1200×630.
//
// The card is the Hero's block art beside the site's name, its title line and its address. The words are read
// where they are decided, so the card cannot keep a line the site has dropped: the name and the line are the
// English page title (`meta.title` in src/lib/landing-copy.ts, "<name> — <line>"), and the address is the
// production site origin (`web.siteOrigin` in deploy/profiles/production.json). The image carries the words it
// was drawn with as its JPEG comment, and share-card.test.mjs fails when they are no longer the site's: run this
// again and commit the image.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runCliMain } from "../../../scripts/cli-entrypoint.mjs";

const require = createRequire(import.meta.url);
require("../src/components/dashboard/typescript-require.cjs").installTypeScriptRequire();

export const CARD = fileURLToPath(new URL("../public/brand/xmatrix-share-card.jpg", import.meta.url));

/** The card's words as the site has them now: its name, its title line and its address. */
export async function cardWords() {
  const [name, line] = require("../src/lib/landing-copy.ts").landingCopy.en.meta.title.split(" — ");
  if (!name || !line) throw new Error('share card: the English page title must read "<name> — <line>"');
  const profile = JSON.parse(await readFile(new URL("../../../deploy/profiles/production.json", import.meta.url), "utf8"));
  return { name, line, address: new URL(profile.web.siteOrigin).host };
}

const SOI = 0xffd8, APP0 = 0xffe0, COMMENT = 0xfffe;

/** A JPEG with `words` as its comment, after the JFIF header a decoder expects first. */
function withWords(jpeg, words) {
  if (jpeg.readUInt16BE(0) !== SOI) throw new Error("share card: not a JPEG");
  const at = jpeg.readUInt16BE(2) === APP0 ? 4 + jpeg.readUInt16BE(4) : 2;
  const text = Buffer.from(JSON.stringify(words), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt16BE(COMMENT, 0);
  head.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, at), head, text, jpeg.subarray(at)]);
}

/** The words a card says it was drawn with; null for an image that does not say. */
export function wordsDrawnOn(jpeg) {
  for (let at = 2; at + 4 <= jpeg.length && jpeg[at] === 0xff && jpeg.readUInt16BE(at) !== 0xffda;) {
    const length = jpeg.readUInt16BE(at + 2);
    if (jpeg.readUInt16BE(at) === COMMENT) return JSON.parse(jpeg.subarray(at + 4, at + 2 + length).toString("utf8"));
    at += 2 + length;
  }
  return null;
}

const inline = async (path, type) =>
  `data:${type};base64,${(await readFile(new URL(`../public/${path}`, import.meta.url))).toString("base64")}`;
const escaped = (text) => text.replace(/[&<>]/gu, (mark) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[mark]);

async function draw() {
  const words = await cardWords();
  // The art is placed so its blocks fill the right half; its own paper is the card's ground, so it has no edge.
  const html = `<!doctype html><meta charset="utf-8"><style>
    @font-face { font-family: Manrope; font-weight: 200 800;
      src: url(${await inline("fonts/manrope-latin-wght-normal.a30ddcd349.woff2", "font/woff2")}) format("woff2"); }
    html, body { margin: 0; }
    body { position: relative; width: 1200px; height: 630px; overflow: hidden; background: rgb(241 236 237);
      font-family: Manrope, sans-serif; -webkit-font-smoothing: antialiased; }
    img { position: absolute; top: -77px; left: 115px; width: 1121px; mask-image: linear-gradient(90deg, transparent, #000 14%); }
    div { position: absolute; top: 0; left: 80px; display: flex; height: 630px; flex-direction: column; justify-content: center; }
    h1 { margin: 0; color: #171714; font-size: 102px; font-weight: 600; letter-spacing: -0.02em; line-height: 1; }
    p { max-width: 520px; margin: 26px 0 0; color: #6d6c67; font-size: 35px; font-weight: 500; line-height: 1.25; text-wrap: balance; }
    small { display: block; margin-top: 52px; color: #9a6a35; font-size: 23px; font-weight: 500; }
  </style>
  <img src="${await inline("brand/xmatrix-hero-wood-liquid-glass-ai-logos-compact.png", "image/png")}" alt="">
  <div><h1>${escaped(words.name)}</h1><p>${escaped(words.line)}</p><small>${escaped(words.address)}</small></div>`;

  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await writeFile(CARD, withWords(await page.screenshot({ type: "jpeg", quality: 90 }), words));
  } finally {
    await browser.close();
  }
  process.stderr.write(`wrote ${CARD}: ${Object.values(words).join(" / ")}\n`);
}

await runCliMain(import.meta.url, draw);
