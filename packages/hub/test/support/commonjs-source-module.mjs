import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/** Compile once; each evaluation gets its own exports and explicit import boundary. */
export async function compileCommonJsSourceModule(path) {
  const source = await readFile(path, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  return (resolveImport, context) => {
    const exports = {};
    if (context) runInNewContext(outputText, { ...context, exports, require: resolveImport });
    else new Function("require", "exports", outputText)(resolveImport, exports);
    return exports;
  };
}

/** Evaluate one repository module against the test's explicit import boundary. */
export async function loadCommonJsSourceModule(path, resolveImport) {
  return (await compileCommonJsSourceModule(path))(resolveImport);
}
