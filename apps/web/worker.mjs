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
        // Only content-addressed JS/CSS can outlive a Web deployment. The
        // assets binding otherwise requires a network revalidation on every launch.
        const filename = url.pathname.split("/").at(-1);
        if ((asset.status === 200 || asset.status === 304) &&
            /^\/_next\/static\/(?:chunks|css)\//.test(url.pathname) &&
            /(?:^|[-.])[0-9a-f]{8,}\.(?:js|css)$/.test(filename)) {
          const response = new Response(asset.body, asset);
          response.headers.set("cache-control", "public, max-age=31536000, immutable");
          return response;
        }
        return asset;
      }
      await asset.body?.cancel();
    }
    return handler.fetch(request, env, ctx);
  },
};
