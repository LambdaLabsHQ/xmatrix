const fs = require("node:fs");
const Module = require("node:module");
const ts = require("typescript");

let installed = false;

function installTypeScriptRequire() {
  if (installed) return;
  installed = true;
  Module._extensions[".ts"] = (target, filename) => {
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    target._compile(compiled.outputText, filename);
  };
}

module.exports = { installTypeScriptRequire };
