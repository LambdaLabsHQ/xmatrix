#!/usr/bin/env node
// Copies the pages `next build` prerendered (.open-next/cache/<build id>/) into
// the Worker's static assets, where open-next.config.ts's read-only cache reads
// them (cdn-cgi/_next_cache/, reachable only from the Worker). They are uploaded
// with the same deploy as the chunks they name. `opennextjs-cloudflare deploy`
// does this itself; releases run `wrangler deploy`, so the build does it here.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isCliMain } from "../../../scripts/cli-entrypoint.mjs";

// Every launch opens /app, which middleware.ts rewrites to this page.
const REQUIRED_PAGES = ["workspace"];

export function populateStaticPageCache(openNextDir) {
  const buildId = readFileSync(join(openNextDir, "assets", "BUILD_ID"), "utf8").trim();
  const source = join(openNextDir, "cache");
  const target = join(openNextDir, "assets", "cdn-cgi", "_next_cache");
  for (const page of REQUIRED_PAGES) {
    const file = join(source, buildId, `${page}.cache`);
    if (!existsSync(file)) {
      throw new Error(`next build did not prerender /${page} (missing ${file}); it would be rendered on every request`);
    }
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  return { buildId, target };
}

if (isCliMain(import.meta.url)) {
  const { buildId, target } = populateStaticPageCache(join(import.meta.dirname, "..", ".open-next"));
  console.log(`Prerendered pages of build ${buildId} copied to ${target}`);
}
