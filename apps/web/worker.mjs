import handler from "./.open-next/worker.js";
export * from "./.open-next/worker.js";

export default {
  ...handler,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Loopback and dot-less hosts (localhost, wrangler's `placeholder`) are never public.
    if (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname.includes(".")) {
      // Run before OpenNext and assets; forwarded headers cannot bypass TLS.
      url.protocol = "https:";
      return Response.redirect(url.href, 308);
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) {
        // Only content-addressed files can outlive a Web deployment: Next's
        // JS/CSS, and the fonts and textures whose names carry their hash
        // (public-asset-hashes.test.mjs). The assets binding otherwise
        // requires a network revalidation on every launch.
        const filename = url.pathname.split("/").at(-1);
        if ((asset.status === 200 || asset.status === 304) && (
          (/^\/_next\/static\/(?:chunks|css)\//.test(url.pathname) &&
            /(?:^|[-.])[0-9a-f]{8,}\.(?:js|css)$/.test(filename)) ||
          /^\/(?:fonts|textures)\/[^/]+\.[0-9a-f]{10}\.(?:woff2|webp)$/.test(url.pathname))) {
          const response = new Response(asset.body, asset);
          response.headers.set("cache-control", "public, max-age=31536000, immutable");
          return response;
        }
        // Avatars, App marks and app icons are drawn on every message row or
        // launch. Revalidating each one every time keeps faces blank for a
        // round trip; a changed icon reaching readers within a day is fine.
        if ((asset.status === 200 || asset.status === 304) && (
          /^\/(?:agent-vendors|app-connectors|brand|role-avatars)\//.test(url.pathname) ||
          /^\/(?:favicon\.ico|apple-touch-icon\.png|(?:android-chrome|icon)-[0-9x]+\.png)$/.test(url.pathname))) {
          const response = new Response(asset.body, asset);
          response.headers.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");
          return response;
        }
        return asset;
      }
      await asset.body?.cancel();
    }
    const response = await handler.fetch(request, env, ctx);
    // A prerendered page (`/app` among them) is answered from this build's copy
    // with `s-maxage` for a year. Its HTML names this build's chunks, which the
    // next deploy removes, so no cache may keep it past a deploy: every cache,
    // shared or not, asks again each time.
    if (/^s-maxage=/.test(response.headers.get("cache-control") ?? "")) {
      const revalidated = new Response(response.body, response);
      revalidated.headers.set("cache-control", "public, max-age=0, must-revalidate");
      return revalidated;
    }
    return response;
  },
};
