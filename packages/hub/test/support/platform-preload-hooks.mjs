// ESM resolve hook for platform-preload.mjs. Async module.register hooks leave
// CommonJS require() and require.cache untouched (miniflare depends on them).
const stub = new URL("./unexpected-platform-construction.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("cloudflare:")) return { shortCircuit: true, url: stub };
  return nextResolve(specifier, context);
}
