const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("only filled glass surfaces opt into the lens, and its defs render once", () => {
  const componentsDir = path.join(__dirname, "..");
  const mounts = [];
  for (const dir of fs.readdirSync(componentsDir)) {
    const full = path.join(componentsDir, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (file.endsWith(".tsx") && /<LiquidGlassLensDefs/.test(fs.readFileSync(path.join(full, file), "utf8"))) {
        mounts.push(`${dir}/${file}`);
      }
    }
  }
  assert.deepEqual(mounts, [], "the root layout is the single mount, so filter ids never repeat");
});
