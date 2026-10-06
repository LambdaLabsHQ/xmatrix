/**
 * Compile a TypeScript module and its local siblings for `node --test`.
 *
 * Tests here execute dashboard modules by transpiling them to CommonJS in a
 * temp directory. A module with no imports compiles alone, but the moment one
 * of them imports a sibling — as several now do, sharing one implementation
 * instead of copying it — a lone transpile fails at `require("./sibling")`.
 *
 * So the whole set is emitted into one directory, as `.js` beside a
 * `package.json` marking it CommonJS: `require("./x")` resolves `.js` and
 * never `.cjs`, and without the marker Node would read the nearest real
 * package.json and treat the output as ESM. The web app's `node_modules` is
 * linked in, so a module can import workspace packages such as
 * `@xmatrix/protocol` at runtime, not only for types.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

/**
 * @param {string} sourceDir directory holding the `.ts` sources
 * @param {string[]} moduleNames extensionless names; the first is the entry point
 * @returns {{ exports: unknown, dispose: () => void }}
 */
function compileTsModules(sourceDir, moduleNames) {
  const compiledDir = fs.mkdtempSync(path.join(os.tmpdir(), `xmatrix-ts-${process.pid}-`));
  fs.writeFileSync(path.join(compiledDir, "package.json"), JSON.stringify({ type: "commonjs" }));
  fs.symlinkSync(path.resolve(__dirname, "../../../node_modules"), path.join(compiledDir, "node_modules"), "junction");
  let entryPath = "";
  for (const name of moduleNames) {
    const compiled = ts.transpileModule(
      fs.readFileSync(path.join(sourceDir, `${name}.ts`), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      },
    );
    const compiledPath = path.join(compiledDir, `${name}.js`);
    fs.writeFileSync(compiledPath, compiled.outputText);
    if (!entryPath) entryPath = compiledPath;
  }
  return {
    exports: require(entryPath),
    dispose: () => fs.rmSync(compiledDir, { force: true, recursive: true }),
  };
}

module.exports = { compileTsModules };
