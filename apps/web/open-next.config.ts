import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// A prerendered page (○ in `next build`) is answered from the copy this build
// wrote, before any route code loads, instead of being rendered again by every
// cold isolate. The copies are uploaded with this build's own assets under
// cdn-cgi/_next_cache/<build id>/ (scripts/populate-static-page-cache.mjs), so
// a page always names chunks of the deploy that serves it. Nothing is ever
// written back: the cache is read-only, and no page here revalidates.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
