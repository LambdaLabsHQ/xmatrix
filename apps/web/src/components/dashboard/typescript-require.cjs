const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

let installed = false;

function installTypeScriptRequire() {
  if (installed) return;
  installed = true;
  // `@/` names the app's `src/`, as its tsconfig maps it.
  const src = path.resolve(__dirname, "../..");
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return resolveFilename.call(this, request.startsWith("@/") ? path.join(src, request.slice(2)) : request, ...rest);
  };
  Module._extensions[".ts"] = Module._extensions[".tsx"] = (target, filename) => {
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    target._compile(compiled.outputText, filename);
  };
}

module.exports = { installTypeScriptRequire };
