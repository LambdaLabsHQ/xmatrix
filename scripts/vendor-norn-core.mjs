// Refresh what a host needs to check Norn programs and evaluate them against a
// request ledger. The source checkout is local; git reads the pinned revision.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const revision = "e2ad669ba30822030d8d0bb86279b990b3e5f996";
const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node scripts/vendor-norn-core.mjs <norn-checkout>");
const root = fileURLToPath(new URL("../packages/hub/src/vendor/norn/", import.meta.url));
const git = (...args) => execFileSync("git", ["-C", resolve(checkout), ...args], { encoding: "utf8" });
// The whole frontend except the reader of files, which needs Node.
const frontend = git("ls-tree", "-r", "--name-only", revision, "src/frontend").trim().split("\n")
  .map(path => path.slice("src/".length)).filter(file => file !== "frontend/check/node.ts");
// The evaluator and the ledger; not the simulated team or the browser entry.
const runtime = ["code", "machine", "pattern", "value", "std", "sha256", "form", "ledger"].map(name => `runtime/${name}.ts`);
const files = [...frontend, ...runtime].sort();
// Each patch must find its text, so a refresh cannot silently drop one.
const patches = {
  "runtime/machine.ts": [
    ["values: Value[], env: string): void {", "values: Value[], _env: string): void {", "unused parameter `env` renamed `_env`"],
    ["function builtin(code: Code,", "function builtin(_code: Code,", "unused parameter `code` renamed `_code`"],
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
writeFileSync(resolve(root, "README.md"), `# Norn snapshot

Source: https://github.com/norn-lang/norn/tree/${revision}

Apache-2.0; see LICENSE. The parser, the checker, the compiler, the evaluator and
the request ledger are included. A program stores no state of its own: each pass
evaluates it from the top against a ledger the host keeps.
The file reader (\`frontend/check/node.ts\`), the simulated team, the browser
entry, the CLI and the standard library text are not included.
Refresh with \`node scripts/vendor-norn-core.mjs <local-norn-checkout>\`.

## Files

${files.map(file => `- \`${file}\``).join("\n")}

## Changes from upstream

Never edit these files by hand. The script applies every change:

- every file: a provenance header, and \`.ts\` import suffixes rewritten to \`.js\`
${Object.entries(patches).flatMap(([file, list]) => list.map(([, , why]) => `- \`${file}\`: ${why}`)).join("\n")}
`);
