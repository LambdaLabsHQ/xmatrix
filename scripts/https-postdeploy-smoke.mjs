import { pathToFileURL } from "node:url";

export async function verifyHttpsRedirect(origin, fetchImpl = fetch) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Expected an HTTPS origin");
  }
  // Include an asset and a query so middleware-only fixes cannot pass.
  for (const path of ["/", "/icon-32.png", "/favicon.ico", "/api/web-build?https_probe=a%2Fb&n=1"]) {
    const secure = new URL(path, base);
    const insecure = new URL(secure);
    insecure.protocol = "http:";
    const response = await fetchImpl(insecure, {
      redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    if (![301, 302, 307, 308].includes(response.status) ||
        response.headers.get("location") !== secure.href) {
      throw new Error(`${insecure.href}: expected same-path HTTPS redirect, got ${response.status} / ${response.headers.get("location")}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length < 3) throw new Error("Usage: https-postdeploy-smoke.mjs <https-origin> [...]");
  for (const origin of process.argv.slice(2)) {
    await verifyHttpsRedirect(origin);
    console.log(`HTTPS redirect verified: ${origin}`);
  }
}
