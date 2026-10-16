import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/* worker.mjs serves fonts and textures as immutable for a year because each
   name carries its content hash. A file whose bytes changed under the same
   name would stay stale in every browser that ever loaded it. */
for (const directory of ["fonts", "textures"]) {
  test(`every ${directory} file is named by its content hash`, () => {
    const root = new URL(`./public/${directory}/`, import.meta.url);
    for (const name of readdirSync(root)) {
      if (!/\.(?:woff2|webp)$/.test(name)) continue;
      const hash = createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex").slice(0, 10);
      assert.match(name, /\.[0-9a-f]{10}\.(?:woff2|webp)$/, `${name} needs its content hash in its name`);
      assert.equal(name.split(".").at(-2), hash, `${name} changed: rename it to its new hash ${hash}`);
    }
  });
}
