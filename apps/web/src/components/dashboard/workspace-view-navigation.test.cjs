const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { adminViewPath, viewSelectionPath } = require("./workspace-shell-navigation.ts");

test("Apps canonicalization removes item and preserves connector return parameters", () => {
  const path = adminViewPath("/app/lambda/apps",
    "/app/space-id/apps?item=github&connector=gmail&gmailWatchState=state&gmailWatchCode=code&oauth=connected#detail");
  assert.equal(new URL(path, "https://xmatrix.test").hash, "#detail");
  const query = new URL(path, "https://xmatrix.test").searchParams;
  assert.equal(query.has("item"), false);
  assert.equal(query.get("connector"), "gmail");
  assert.equal(query.get("gmailWatchState"), "state");
  assert.equal(query.get("gmailWatchCode"), "code");
  assert.equal(query.get("oauth"), "connected");
});

test("each destination owns a semantic field and no item alias", () => {
  for (const [view, parameter] of [["agents", "agent"], ["machines", "machine"], ["automation", "schedule"], ["settings", "section"], ["admin", "section"], ["team", "space"]]) {
    assert.equal(viewSelectionPath(`/app/lambda/${view}`, `/app/lambda/${view}?${parameter}=selected&item=old`), `/app/lambda/${view}?${parameter}=selected`);
    assert.equal(viewSelectionPath(`/app/lambda/${view}`, `/app/lambda/${view}?item=old`), `/app/lambda/${view}`);
  }
});

/* `/billing` kept writing the retired `item` field after #1203, so Stripe
   Checkout returned people to Settings › Account. A view's selection field
   is named only in protocol APP_VIEW_SELECTION_FIELDS; every address and
   reader goes through it. */
test("no address or reader names a view's selection field by hand", () => {
  const { execFileSync } = require("node:child_process");
  const path = require("node:path");
  const root = path.resolve(__dirname, "../../../../..");
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps/web/src", "packages/hub/src"],
    { cwd: root, encoding: "utf8" }).split("\n").filter((file) => /\.(ts|tsx)$/u.test(file) && !/\.test\.|\/test\//u.test(file));
  const fields = "connector|agent|machine|schedule|section|item";
  const handWritten = [
    new RegExp(`[?&](${fields})=`, "u"),
    new RegExp(`\\.(set|get|append|has)\\(\\s*["'](${fields})["']`, "u"),
    /useUrlParameter\(/u,
  ];
  const offenders = [];
  for (const file of files) {
    const lines = require("node:fs").readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/^\s*(\*|\/\/|\/\*)/u.test(line)) return;
      if (handWritten.some((pattern) => pattern.test(line))) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
