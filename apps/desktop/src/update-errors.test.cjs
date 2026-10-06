const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const mainSourcePath = path.join(__dirname, "main.ts");
let readableUpdateErrorMessage;
let shouldShowUpdateRecovery;

test.before(async () => {
  const loaded = await import("./update-errors.ts");
  readableUpdateErrorMessage = loaded.readableUpdateErrorMessage;
  shouldShowUpdateRecovery = loaded.shouldShowUpdateRecovery;
});

test("readableUpdateErrorMessage explains macOS signature validation failures", () => {
  assert.match(
    readableUpdateErrorMessage(
      new Error("Code signature at URL file:///tmp/xMatrix.app did not pass validation")
    ),
    /reinstall it once; automatic updates will resume afterwards/
  );
  assert.match(
    readableUpdateErrorMessage(new Error("code failed to satisfy specified code requirement(s)")),
    /macOS could not verify this update/
  );
});

test("readableUpdateErrorMessage preserves bounded actionable errors", () => {
  assert.equal(
    readableUpdateErrorMessage(new Error("network unavailable")),
    "network unavailable"
  );
  assert.match(
    readableUpdateErrorMessage(new Error("x".repeat(241))),
    /See the desktop logs/
  );
});

test("shouldShowUpdateRecovery covers every user-initiated update phase", () => {
  assert.equal(
    shouldShowUpdateRecovery({
      manualUpdateCheck: true,
      manualDownloadInProgress: false,
      state: "checking",
    }),
    true
  );
  assert.equal(
    shouldShowUpdateRecovery({
      manualUpdateCheck: false,
      manualDownloadInProgress: true,
      state: "downloaded",
    }),
    true
  );
  assert.equal(
    shouldShowUpdateRecovery({
      manualUpdateCheck: false,
      manualDownloadInProgress: false,
      state: "installing",
    }),
    true
  );
  assert.equal(
    shouldShowUpdateRecovery({
      manualUpdateCheck: false,
      manualDownloadInProgress: false,
      state: "downloading",
    }),
    false
  );
});

test("main process retains manual update context through native macOS validation", () => {
  const source = require("node:fs").readFileSync(mainSourcePath, "utf8");
  const downloadedHandler = source.slice(
    source.indexOf('autoUpdater.on("update-downloaded"'),
    source.indexOf('autoUpdater.on("error"')
  );
  assert.doesNotMatch(downloadedHandler, /updateDownloadStartedFromManualCheck\s*=\s*false/);
  assert.match(source, /shouldShowUpdateRecovery\(\{[\s\S]*manualDownloadInProgress:/);
  assert.match(source, /void showUpdateErrorDialog\(message\)/);
});
