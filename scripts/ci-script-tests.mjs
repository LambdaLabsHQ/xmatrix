import fs from "node:fs";
import path from "node:path";

function normalizePath(file) {
  return file.replaceAll(path.sep, "/");
}

export function discoverScriptTests(rootDir) {
  const scriptsDir = path.join(rootDir, "scripts");
  return fs
    .readdirSync(scriptsDir, { recursive: true, encoding: "utf8" })
    .map(normalizePath)
    .filter((file) => file.endsWith(".test.mjs"))
    .map((file) => `scripts/${file}`)
    .sort();
}
