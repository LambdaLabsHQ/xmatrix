const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { scratchDirectory } = require("./desktop.test-fixture.cjs");

const sourcePath = path.join(__dirname, "cli-session.ts");
let writePrivateJsonAtomic;

test.before(async () => {
  const loaded = await import("./cli-session.ts");
  writePrivateJsonAtomic = loaded.writePrivateJsonAtomic;
});

test("private JSON writes use collision-free temporary files", async () => {
  const dir = scratchDirectory("xmatrix-desktop-atomic-json-");
  const target = path.join(dir, "selection.json");
  try {
    await Promise.all([
      writePrivateJsonAtomic(target, { profileId: "profile:first" }),
      writePrivateJsonAtomic(target, { profileId: "profile:second" }),
    ]);
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.ok(["profile:first", "profile:second"].includes(value.profileId));
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.startsWith("selection.json.tmp-")),
      [],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the session layout lives in the CLI, not in the App", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  for (const rule of ["production.json", "custom-", "profiles.json", "legacy-root", "sessions", "sha256", "session.json"]) {
    assert.ok(!source.includes(rule), `cli-session.ts must not know about ${rule}`);
  }
});
