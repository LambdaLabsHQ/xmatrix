// Refresh only the pure evaluator, never the upstream dispatcher or stores.
// The source checkout is local; git show reads the immutable audited revision.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const revision = "5866bf327c23914e3aa0971c6e482554a307c3d5";
const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node scripts/vendor-norn-core.mjs <norn-checkout>");
const root = fileURLToPath(new URL("../packages/hub/src/vendor/norn/", import.meta.url));
const files = ["frontend/ast.ts", "frontend/json.ts", "runtime/code.ts", "runtime/machine.ts",
  "runtime/pattern.ts", "runtime/value.ts", "runtime/std.ts", "runtime/sha256.ts"];
for (const file of [...files, "LICENSE"]) {
  const source = execFileSync("git", ["-C", resolve(checkout), "show", `${revision}:${file === "LICENSE" ? file : `src/${file}`}`], { encoding: "utf8" });
  const destination = resolve(root, file);
  mkdirSync(dirname(destination), { recursive: true });
  const portable = source.replaceAll(/(from\s+"[^"]+)\.ts"/gu, '$1.js"')
    .replace("values: Value[], env: string): void {", "values: Value[], _env: string): void {")
    .replace("function builtin(code: Code,", "function builtin(_code: Code,");
  writeFileSync(destination, file === "LICENSE" ? source :
    `// Vendored from norn-lang/norn@${revision}; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.\n` +
      portable);
}
writeFileSync(resolve(root, "README.md"), `# Norn evaluator snapshot\n\nSource: https://github.com/norn-lang/norn/tree/${revision}\n\nApache-2.0; see LICENSE. Only the pure AST reader, compiler and evaluator are included.\nNo MemoryStore, SQLite, simulated host, dispatcher, transport or credentials are imported.\nRefresh with \`node scripts/vendor-norn-core.mjs <local-norn-checkout>\`.\nUpstream source is preserved except for relative import suffixes, provenance headers and two unused parameter names prefixed for the host compiler.\n`);
