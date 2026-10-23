import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { appStoreReleaseNotes, authoredReleaseNotes, composeReleaseNotes, generatedBetaReleaseNotes } from "./release-notes.mjs";

// These protect publication content and its transaction boundary. The train's
// repository test separately proves that notes must be in the candidate tree.
test("stable notes are version-specific, nonempty and cannot carry transaction markers", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "xmatrix-notes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "docs/releases");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "1.2.0.md");
  assert.throws(() => authoredReleaseNotes(root, "1.2.0"), /Missing release notes/u);
  for (const invalid of ["# xMatrix 1.1.0\n\nOld notes", "# xMatrix 1.2.0\n", "# xMatrix 1.2.0\n\n<!-- xmatrix-release-transaction:1:1 -->", `# xMatrix 1.2.0\n\n${"x".repeat(32_768)}`]) {
    writeFileSync(file, invalid);
    assert.throws(() => authoredReleaseNotes(root, "1.2.0"), /must start/u);
  }
  writeFileSync(file, "# xMatrix 1.2.0\n\n## Improvements\n\nRead release notes before updating.\n");
  assert.equal(authoredReleaseNotes(root, "1.2.0"), "## Improvements\n\nRead release notes before updating.");
  assert.match(appStoreReleaseNotes(root, "1.2.0"), /^Improvements\n\nRead release notes before updating\./u);
  writeFileSync(file, `# xMatrix 1.2.0\n\n${"界".repeat(5000)}`);
  const storeNotes = appStoreReleaseNotes(root, "1.2.0");
  assert.equal([...storeNotes].length, 4000);
  assert.ok(storeNotes.endsWith("…\n\nFull release notes: https://xmatrix.sh/releases/1.2.0"));
  assert.throws(() => authoredReleaseNotes(root, "../../outside"), /version/iu);
});

test("beta generation bypasses stale release lists and names the previous published version, excluding newer versions and drafts", async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options) => {
    const request = new URL(url);
    if (request.pathname.endsWith("/releases")) {
      // An intermediary can retain the old first-page response even after a
      // newer beta is published. Its old baseline expands the whole history.
      const fresh = request.searchParams.has("_xmatrix_read") &&
        options.headers["Cache-Control"] === "no-cache" && options.cache === "no-store";
      if (!fresh) return Response.json([{ tag_name: "xmatrix-v1.0.0" }]);
      return Response.json([
        { tag_name: "xmatrix-v1.1.1-beta.9" }, { tag_name: "xmatrix-v1.1.1-beta.2" },
        { tag_name: "xmatrix-v1.1.1-beta.3", draft: true }, { tag_name: "xmatrix-v1.1.0" }, { tag_name: "cli-dev" },
      ]);
    }
    assert.equal(url, "https://api.github.com/repos/LambdaLabsHQ/xmatrix/releases/generate-notes");
    assert.deepEqual(JSON.parse(options.body), { tag_name: "xmatrix-v1.1.1-beta.4", previous_tag_name: "xmatrix-v1.1.1-beta.2" });
    return Response.json({ body: "Changes since the previous beta." });
  };
  assert.equal(await generatedBetaReleaseNotes({ repository: "LambdaLabsHQ/xmatrix", tag: "xmatrix-v1.1.1-beta.4", token: "test" }), "Changes since the previous beta.");
});

test("publication keeps authored changes before the receipt and rejects forged control metadata", () => {
  assert.equal(composeReleaseNotes({ notes: "A useful change.", receipt: "Exact production evidence." }),
    "<!-- xmatrix-release-notes:v1 -->\nA useful change.\n\n## Deployment receipt\n\nExact production evidence.");
  for (const notes of ["", "<!-- xmatrix-release-transaction:other:1 -->", "x".repeat(100_001)]) {
    assert.throws(() => composeReleaseNotes({ notes, receipt: "receipt" }), /bounded text/u);
  }
});
