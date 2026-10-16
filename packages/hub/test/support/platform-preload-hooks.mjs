import { readFile } from "node:fs/promises";

// ESM resolve hook for platform-preload.mjs. Async module.register hooks leave
// CommonJS require() and require.cache untouched (miniflare depends on them).
const stub = new URL("./unexpected-platform-construction.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("cloudflare:")) return { shortCircuit: true, url: stub };
  return nextResolve(specifier, context);
}

// Wrangler imports the repository prompt documents as Text modules.
export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && new URL(url).pathname.includes("/crates/core/prompts/") && url.endsWith(".md")) {
    return { shortCircuit: true, format: "module",
      source: `export default ${JSON.stringify(await readFile(new URL(url), "utf8"))};` };
  }
  return nextLoad(url, context);
}
