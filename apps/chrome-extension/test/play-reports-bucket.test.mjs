import assert from "node:assert/strict";
import test from "node:test";

import {
  extractPlayBucketsFromText,
  findOpenPlayConsoleBuckets,
  isPlayConsoleUrl,
  isPlayDownloadReportsUrl,
  playDownloadReportsUrl,
  readPlayBucketsFromTab,
  scanDocumentForPlayBuckets,
} from "../src/play-reports-bucket.js";

test("only https://play.google.com/console routes are recognized as Play Console", () => {
  assert.equal(isPlayConsoleUrl("https://play.google.com/console/u/0/developers/123456/download-reports/statistics"), true);
  assert.equal(isPlayConsoleUrl("https://play.google.com/console"), true);
  assert.equal(isPlayConsoleUrl("https://play.google.com/store/apps/details?id=sh.xmatrix.app"), false);
  assert.equal(isPlayConsoleUrl("http://play.google.com/console/developers"), false);
  assert.equal(isPlayConsoleUrl("https://evil.play.google.com/console/developers"), false);
  assert.equal(isPlayConsoleUrl("https://play.google.com/console-fake"), false);

  assert.equal(isPlayDownloadReportsUrl("https://play.google.com/console/u/0/developers/123/download-reports/statistics"), true);
  assert.equal(isPlayDownloadReportsUrl("https://play.google.com/console/u/0/developers/123/app-list"), false);
  assert.equal(
    playDownloadReportsUrl("https://play.google.com/console/u/1/developers/9876543210/app-list"),
    "https://play.google.com/console/u/1/developers/9876543210/download-reports/statistics",
  );
  assert.equal(
    playDownloadReportsUrl("https://play.google.com/console/developers/9876543210/app-list"),
    "https://play.google.com/console/developers/9876543210/download-reports/statistics",
  );
  assert.equal(playDownloadReportsUrl("https://example.com"), "https://play.google.com/console/developers");
});

test("extractPlayBucketsFromText extracts deduplicated Play Cloud Storage bucket IDs only", () => {
  const text = `
    Cloud Storage URI: gs://pubsite_prod_rev_01234567890123456789/stats/installs/
    Legacy bucket: pubsite_prod_1234567890
    Duplicate: gs://pubsite_prod_rev_01234567890123456789/earnings/
    Ignored: pubsite_prod_rev_123 my_other_bucket pubsite_prod_rev_abc
  `;
  assert.deepEqual(extractPlayBucketsFromText(text), [
    "pubsite_prod_rev_01234567890123456789",
    "pubsite_prod_1234567890",
  ]);
});

test("scanDocumentForPlayBuckets fails closed off Play Console and never reads cookies, scripts, or password fields", (t) => {
  const prevLocation = globalThis.location;
  const prevDocument = globalThis.document;
  t.after(() => {
    if (prevLocation === undefined) delete globalThis.location;
    else globalThis.location = prevLocation;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  });

  let cookieReads = 0;
  const makeDoc = (body) => ({
    get cookie() {
      cookieReads += 1;
      return "SID=secret_pubsite_prod_rev_99999999999999999999";
    },
    body,
  });

  // Off Play Console: returns empty immediately without touching DOM or cookies.
  globalThis.location = new URL("https://example.com/console");
  globalThis.document = makeDoc({ innerText: "gs://pubsite_prod_rev_11111111111111111111/stats/" });
  assert.deepEqual(scanDocumentForPlayBuckets(), []);
  assert.equal(cookieReads, 0);

  // On Play Console: extracts from visible UI/attrs/links, skips script & password inputs, never reads cookie.
  globalThis.location = new URL("https://play.google.com/console/u/0/developers/1/download-reports/statistics");
  globalThis.document = makeDoc({
    innerText: "Copy Cloud Storage URI",
    children: [
      { tagName: "SCRIPT", innerText: "pubsite_prod_rev_22222222222222222222" },
      { tagName: "INPUT", type: "password", value: "pubsite_prod_rev_33333333333333333333" },
      {
        tagName: "BUTTON",
        getAttribute: (name) => (name === "data-clipboard-text" ? "gs://pubsite_prod_rev_01234567890123456789/stats/installs/" : null),
      },
      {
        tagName: "A",
        getAttribute: (name) => (name === "href" ? "https://console.cloud.google.com/storage/browser/pubsite_prod_rev_09876543210987654321" : null),
      },
    ],
  });
  assert.deepEqual(scanDocumentForPlayBuckets(), [
    "pubsite_prod_rev_01234567890123456789",
    "pubsite_prod_rev_09876543210987654321",
  ]);
  assert.equal(cookieReads, 0);
});

test("readPlayBucketsFromTab and findOpenPlayConsoleBuckets sanitize outputs and prefer Download reports tabs", async () => {
  const executed = [];
  const chromeApi = {
    permissions: { async contains() { return true; } },
    tabs: {
      async query() {
        return [
          { id: 1, active: true, url: "https://play.google.com/console/u/0/developers/1/app-list" },
          { id: 2, active: false, url: "https://play.google.com/console/u/0/developers/1/download-reports/statistics" },
        ];
      },
    },
    scripting: {
      async executeScript({ target }) {
        executed.push(target.tabId);
        if (target.tabId === 2) {
          return [{ result: ["pubsite_prod_rev_01234567890123456789", "evil-value", "SID=cookie"] }];
        }
        return [{ result: [] }];
      },
    },
  };

  assert.deepEqual(await readPlayBucketsFromTab(chromeApi, 2), ["pubsite_prod_rev_01234567890123456789"]);
  executed.length = 0;

  const found = await findOpenPlayConsoleBuckets(chromeApi);
  assert.deepEqual(found, { status: "found", buckets: ["pubsite_prod_rev_01234567890123456789"] });
  assert.equal(executed[0], 2, "Download reports tab is scanned before other Play Console tabs");

  const noPerm = await findOpenPlayConsoleBuckets({
    permissions: { async contains() { return false; } },
  });
  assert.deepEqual(noPerm, { status: "no-permission", buckets: [] });

  const noTab = await findOpenPlayConsoleBuckets({
    permissions: { async contains() { return true; } },
    tabs: { async query() { return []; } },
  });
  assert.deepEqual(noTab, { status: "no-tab", buckets: [] });

  const notFound = await findOpenPlayConsoleBuckets({
    permissions: { async contains() { return true; } },
    tabs: { async query() { return [{ id: 7, active: true, url: "https://play.google.com/console/u/0/developers/555/app-list" }]; } },
    scripting: { async executeScript() { return [{ result: [] }]; } },
  });
  assert.deepEqual(notFound, {
    status: "not-found",
    buckets: [],
    downloadReportsUrl: "https://play.google.com/console/u/0/developers/555/download-reports/statistics",
  });
});
