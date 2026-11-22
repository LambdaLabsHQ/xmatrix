import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isSitePath, siteOriginRedirect } from "./site-host.mjs";

const env = { XMATRIX_SITE_ORIGIN: "https://site.example", XMATRIX_APP_ORIGIN: "https://app.example" };

test("the site origin serves the site's pages, files and assets", () => {
  for (const path of [
    "/", "/zh", "/zh-tw", "/ja", "/ko", "/es",
    "/raft-alternatives", "/t3-code-alternatives", "/conductor-alternatives", "/superset-alternatives",
    "/zh/raft-alternatives", "/zh-tw/t3-code-alternatives", "/ja/conductor-alternatives", "/ko/jules-alternatives", "/es/superset-alternatives",
    "/zh/download", "/zh-tw/support", "/ja/docs", "/ko/docs/syntax", "/es/docs/connectors",
    "/docs", "/docs/setup", "/download", "/support", "/releases", "/releases/1.0.304", "/terms", "/privacy",
    "/subprocessors", "/cookies", "/robots.txt", "/sitemap.xml", "/llms.txt", "/index.md", "/pricing.md",
    "/install.sh", "/_next/static/chunks/main-0123456789abcdef.js", "/brand/xmatrix-share-card.jpg",
    "/fonts/inter.0123456789.woff2", "/icon-192.png", "/api/releases/latest",
    "/71d38a28828cfa8a824127e9320a4668.txt",
  ]) {
    assert.equal(isSitePath(path), true, path);
    assert.equal(siteOriginRedirect(new URL(`https://site.example${path}`), env), null, path);
  }
});

test("everything else at the site origin goes to the app origin, path and query kept", () => {
  for (const path of [
    "/app", "/app/space-1", "/login", "/workspace", "/connect/oauth", "/p/space-1", "/settings", "/docsx",
    "/alternatives", "/alternatives/raft", "/loc", "/loc/zh", "/zh/alternatives", "/zh/alternatives/raft", "/zh/terms",
  ]) {
    assert.equal(isSitePath(path), false, path);
    const response = siteOriginRedirect(new URL(`https://site.example${path}?next=%2Fapp`), env);
    assert.equal(response?.status, 302, path);
    assert.equal(response.headers.get("location"), `https://app.example${path}?next=%2Fapp`);
  }
});

test("the app origin, and a deployment without a site origin, serve everything where it arrives", () => {
  assert.equal(siteOriginRedirect(new URL("https://app.example/app"), env), null);
  assert.equal(siteOriginRedirect(new URL("https://site.example/app"), {}), null);
  assert.equal(siteOriginRedirect(new URL("https://site.example/app"), { XMATRIX_SITE_ORIGIN: "https://site.example" }), null);
  assert.equal(siteOriginRedirect(new URL("https://site.example/app"),
    { XMATRIX_SITE_ORIGIN: "https://site.example", XMATRIX_APP_ORIGIN: "https://site.example" }), null);
});

test("every page the sitemap lists is served at the site origin, not redirected away from it", () => {
  const source = readFileSync(new URL("./src/app/sitemap.ts", import.meta.url), "utf8");
  const list = source.match(/const publicPaths = \[([^\]]*)\]/u)?.[1];
  assert.ok(list, "sitemap.ts names its pages in publicPaths");
  const paths = [...list.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  assert.ok(paths.length > 5, "publicPaths lists the site's pages");
  for (const path of paths) assert.equal(isSitePath(path), true, path);
});

test("robots.ts allows mainstream AI search and training crawlers while blocking high-volume scrapers", () => {
  const source = readFileSync(new URL("./src/app/robots.ts", import.meta.url), "utf8");
  const list = source.match(/const blockedScrapers = \[([^\]]*)\]/u)?.[1];
  assert.ok(list, "robots.ts names blockedScrapers");
  const blocked = new Set([...list.matchAll(/"([^"]+)"/gu)].map((match) => match[1]));
  for (const scraper of ["Amazonbot", "Bytespider", "TikTokSpider"]) {
    assert.equal(blocked.has(scraper), true, `${scraper} should stay blocked`);
  }
  for (const allowed of ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended", "PerplexityBot", "OAI-SearchBot"]) {
    assert.equal(blocked.has(allowed), false, `${allowed} should be allowed`);
  }
});
