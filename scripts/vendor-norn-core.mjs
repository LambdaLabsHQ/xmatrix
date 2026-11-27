// Refresh what a host needs to check Norn programs and evaluate them against a
// request ledger. The source checkout is local; git reads the pinned revision.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const revision = "a5fa3d268e29846ea4a9027e3b989a974d0aa8f8";
const legacyV1StdRevision = "38245c85e0afacad4ce937b6b84fa1d72442af9a";
const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node scripts/vendor-norn-core.mjs <norn-checkout>");
const root = fileURLToPath(new URL("../packages/hub/src/vendor/norn/", import.meta.url));
const git = (...args) => execFileSync("git", ["-C", resolve(checkout), ...args], { encoding: "utf8" });
// The whole frontend except the reader of files, which needs Node.
const frontend = git("ls-tree", "-r", "--name-only", revision, "src/frontend").trim().split("\n")
  .map(path => path.slice("src/".length)).filter(file => file !== "frontend/check/node.ts");
// The evaluator and the ledger; not the simulated team or the browser entry.
const runtime = ["code", "machine", "pattern", "value", "std", "sha256", "form", "ledger", "facts"].map(name => `runtime/${name}.ts`);
const files = [...frontend, ...runtime].sort();
// Each patch must find its text, so a refresh cannot silently drop one.
const patches = {
  "frontend/parser.ts": [
    ['  private noAnnotation(): void {\n    if (this.at(":")) this.fail("type annotations are not part of Norn v0: types are inferred (spec §4)");\n  }\n\n', "", "unused `noAnnotation` helper removed for Hub noUnusedLocals"],
  ],
  "runtime/machine.ts": [
    ["values: Value[], env: string): void {", "values: Value[], _env: string): void {", "unused parameter `env` renamed `_env`"],
  ],
  "runtime/std.ts": [
    ["const module: Statement", "const linkedModule: Statement", "local `module` renamed `linkedModule`"],
    ["[...types, module]", "[...types, linkedModule]", "its one use renamed with it"],
  ],
  "runtime/value.ts": [
    ['`${value.kind}\\"${value.value}\\"`', '`${value.kind}"${value.value}"`', 'redundant `\\"` escapes in a template literal written as `"`'],
  ],
};
rmSync(root, { recursive: true, force: true });
for (const file of [...files, "LICENSE"]) {
  const source = git("show", `${revision}:${file === "LICENSE" ? file : `src/${file}`}`);
  const destination = resolve(root, file);
  mkdirSync(dirname(destination), { recursive: true });
  let portable = source.replaceAll(/(from\s+"[^"]+)\.ts"/gu, '$1.js"');
  for (const [from, to] of patches[file] ?? []) {
    if (!portable.includes(from)) throw new Error(`${file} no longer contains: ${from}`);
    portable = portable.replace(from, to);
  }
  writeFileSync(destination, file === "LICENSE" ? source :
    `// Vendored from norn-lang/norn@${revision}; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.\n` +
      portable);
}
// The standard library is Norn text; a host reads it as a module of its own.
// Retain the pre-#1961 v1 snapshot (`NORN_STD_LEGACY_V1`) so existing unmigrated v1 ledgers
// keep exact AST node numbering for `open Std` + `map` loops across Hub upgrades.
writeFileSync(resolve(root, "std.ts"),
  `// Vendored from norn-lang/norn@${revision} (std/std.norn); Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.\n` +
    `/** The standard library, opened with \`open Std\`. */\nexport const NORN_STD = ${JSON.stringify(git("show", `${revision}:std/std.norn`))};\n` +
    `/** Pre-edition-1 standard library snapshot pinned for legacy v1 ledgers (norn-lang/norn@${legacyV1StdRevision}). */\nexport const NORN_STD_LEGACY_V1 = ${JSON.stringify(git("show", `${legacyV1StdRevision}:std/std.norn`))};\n`);
writeFileSync(resolve(root, "README.md"), `# Norn snapshot

Source: https://github.com/norn-lang/norn/tree/${revision}

Apache-2.0; see LICENSE. The parser, the checker, the compiler, the evaluator and
the request ledger are included. A program stores no state of its own: each pass
evaluates it from the top against a ledger the host keeps.
The standard library's text is \`std.ts\`. The file reader
(\`frontend/check/node.ts\`), the simulated team, the browser entry and the
CLI are not included.
Refresh with \`node scripts/vendor-norn-core.mjs <local-norn-checkout>\`.

## Files

${files.map(file => `- \`${file}\``).join("\n")}

## Changes from upstream

Never edit these files by hand. The script applies every change:

- every file: a provenance header, and \`.ts\` import suffixes rewritten to \`.js\`
${Object.entries(patches).flatMap(([file, list]) => list.map(([, , why]) => `- \`${file}\`: ${why}`)).join("\n")}
`);
