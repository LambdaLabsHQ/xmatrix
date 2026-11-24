const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = (relativePath) => fs.readFileSync(path.join(__dirname, relativePath), "utf8");
const stores = source("app-stores.ts");
const copy = source("site-pages-copy.ts");

test("the store links name the published listings", () => {
  assert.match(stores, /APP_STORE_ID = "6766625147"/);
  assert.match(stores, /ANDROID_PACKAGE = "sh\.xmatrix\.app"/);
});

test("phones are sent to their store; only Preview falls back to the APK", () => {
  const recommendation = source("../components/landing/download-recommendation.tsx");
  assert.match(recommendation, /iOS: \{ href: APP_STORE_URL/);
  assert.match(recommendation, /channel === "stable"\s*\? \{ href: GOOGLE_PLAY_URL/);
  const list = source("../components/landing/desktop-download.tsx");
  assert.match(list, /label: "App Store", href: APP_STORE_URL/);
  assert.match(list, /label: "Google Play", href: GOOGLE_PLAY_URL/);
});

test("every site locale has the phone-store download copy", () => {
  for (const field of ["iosDetail", "iosNote", "androidApkDetail"]) {
    assert.equal(copy.match(new RegExp(`\\n      ${field}: "`, "g"))?.length, 6, field);
  }
  assert.doesNotMatch(copy, /webNote: "iPhone/);
});

test("public pages carry the App Store smart banner and the footer links both stores", () => {
  assert.match(source("site-metadata.ts"), /itunes: \{ appId: APP_STORE_ID \}/);
  assert.match(source("../components/landing/home.tsx"), /\.\.\.smartAppBanner/);
  const footer = source("../components/landing/footer.tsx");
  assert.match(footer, /href: APP_STORE_URL/);
  assert.match(footer, /href: GOOGLE_PLAY_URL/);
});
