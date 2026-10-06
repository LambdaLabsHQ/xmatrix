import { readFile } from "node:fs/promises";
import ts from "typescript";

const compiledUrls = new Map();
const relativeModulePattern = /(?<=\bfrom\s+["']|\bimport\s+["'])(\.[^"']+\.js)(?=["'])/gu;
const relativeJsonPattern = /(?<=\bfrom\s+["']|\bimport\s+["'])(\.[^"']+\.json)(?=["'])/gu;

async function compileToDataUrl(sourceUrl) {
  const key = sourceUrl.href;
  const cached = compiledUrls.get(key);
  if (cached) return cached;

  const source = await readFile(sourceUrl, "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const specifiers = [...new Set(output.match(relativeModulePattern) ?? [])];
  for (const specifier of specifiers) {
    const dependency = new URL(specifier.replace(/\.js$/u, ".ts"), sourceUrl);
    output = output.replaceAll(specifier, await compileToDataUrl(dependency));
  }
  const jsonSpecifiers = [...new Set(output.match(relativeJsonPattern) ?? [])];
  for (const specifier of jsonSpecifiers) {
    const json = await readFile(new URL(specifier, sourceUrl), "utf8");
    output = output.replaceAll(
      specifier,
      `data:application/json;base64,${Buffer.from(json).toString("base64")}`,
    );
  }
  const dataUrl = `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
  compiledUrls.set(key, dataUrl);
  return dataUrl;
}

export async function loadTypescriptModule(sourceUrl) {
  return import(await compileToDataUrl(sourceUrl));
}
