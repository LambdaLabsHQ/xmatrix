const fs = require("node:fs");
const Module = require("node:module");
const ts = require("typescript");

let installed = false;

function installTypeScriptRequire() {
  if (installed) return;
  installed = true;
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
