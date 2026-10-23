import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescriptModule } from "./load-typescript-module.mjs";

const { releaseNotesPath, publishedReleaseNotes } = await loadTypescriptModule(new URL("../src/release-notes.ts", import.meta.url));

test("update links name exactly the stable or beta version and refuse arbitrary paths", () => {
  assert.equal(releaseNotesPath("1.2.0"), "/releases/1.2.0");
  assert.equal(releaseNotesPath("1.1.1-beta.12"), "/releases/1.1.1-beta.12");
  for (const invalid of [undefined, "", "latest", "../1.2.0", "1.2.0?other", "01.2.0", "1.2.0-beta.0"]) {
    assert.equal(releaseNotesPath(invalid), undefined);
  }
});

test("users read release changes without deployment evidence or a legacy receipt presented as notes", () => {
  assert.equal(publishedReleaseNotes("<!-- xmatrix-release-notes:v1 -->\nA useful change.\n\n## Deployment receipt\n\nInternal evidence."), "A useful change.");
  assert.equal(publishedReleaseNotes("Production stable cli release completed."), undefined);
  assert.equal(publishedReleaseNotes(undefined), undefined);
});
