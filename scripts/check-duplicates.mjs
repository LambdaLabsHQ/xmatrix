#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { runCliMain } from "./cli-entrypoint.mjs";
import { rootDir } from "./repository-paths.mjs";

// The package's ESM build imports an extensionless colors/safe path. Its CJS
// entry also lets us pass Infinity, which the JSON/CLI configuration cannot.
const require = createRequire(import.meta.url);
const { detectClones } = require("jscpd");
const { FORMATS, getFormatByFile, tokenize } = createRequire(require.resolve("jscpd"))("@jscpd/tokenizer");
const marker = ["jscpd", "ignore"].join(":");

export async function checkDuplicates(root = rootDir, { silent = false, configFile = ".jscpd.json" } = {}) {
  const config = JSON.parse(await readFile(path.resolve(root, configFile), "utf8"));
  const found = spawnSync("git", [
    "grep", "--untracked", "--exclude-standard", "-n", "-I", "--fixed-strings",
    marker, "--", ".", ":(exclude)*.md",
  ], { cwd: root, encoding: "utf8" });
  if (found.error) throw found.error;
  if (found.status === 0) {
    throw new Error(`Remove duplicate-code ignore markers and deduplicate their contents:\n${found.stdout}`);
  }
  if (found.status !== 1) throw new Error(found.stderr || "Could not check duplicate-code ignore markers");

  // The programmatic detector does not expand gitignore itself. Give it the
  // tracked files plus new, non-ignored files rather than scanning build caches.
  const listing = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (listing.error) throw listing.error;
  if (listing.status !== 0) throw new Error(listing.stderr || "Could not enumerate repository source files");
  const files = listing.stdout.split("\0").filter(Boolean).map(file => path.resolve(root, file))
    .filter(file => {
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
      // Upstream's Docker/Make grammars have no filename mappings. Their
      // conventional basenames must not disappear through extension filtering.
      if (/^(?:Dockerfile|Containerfile|(?:GNU)?Makefile)(?:[._-].+)?$/iu.test(path.basename(file))) {
        throw new Error(`Conventional source needs explicit language dispatch before it can be scanned: ${file}`);
      }
      if (path.extname(file)) return true;
      const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
      if (!firstLine.startsWith("#!")) return false;
      if (/\b(?:ba|k|z)?sh\b/u.test(firstLine)) return true;
      throw new Error(`Give extensionless source a language extension so it can be scanned: ${file}`);
    });
  // Git hooks are executable source even though their names have no suffix.
  const formatsExts = Object.fromEntries(config.format.map(format => [format, [...FORMATS[format].exts]]));
  formatsExts.bash = [...(formatsExts.bash ?? []), ""];
  // Loading JSX/TSX and their parent grammars mutates Prism's language table.
  // Finish initialization before scanning so file order cannot change lexing.
  const usedFormats = new Set(files.map(file => getFormatByFile(file, formatsExts)).filter(Boolean));
  for (const format of config.format) {
    if (usedFormats.has(format)) tokenize("", format);
  }
  const clones = await detectClones({
    ...config,
    path: files,
    formatsExts,
    ignore: config.ignore.map(pattern => pattern.startsWith("**/") ? pattern : path.resolve(root, pattern)),
    maxLines: Infinity,
    maxSize: Infinity,
    noSymlinks: true,
    silent,
    noTips: true,
  });
  // A percentage rounded to 0 is still a failure when there is one clone.
  if (clones.length) throw new Error(`Duplicate-code gate failed: ${clones.length} clone(s); required: 0.`);
}

runCliMain(import.meta.url, async () => {
  await checkDuplicates();
});
