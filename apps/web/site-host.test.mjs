import assert from "node:assert/strict";
import { test } from "node:test";
import { isSitePath, siteOriginRedirect } from "./site-host.mjs";

const env = { XMATRIX_SITE_ORIGIN: "https://site.example", XMATRIX_APP_ORIGIN: "https://app.example" };

test("the site origin serves the site's pages, files and assets", () => {
  for (const path of [
    "/", "/zh", "/docs", "/docs/setup", "/download", "/releases", "/releases/1.0.304", "/terms", "/privacy",
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
  for (const path of ["/app", "/app/space-1", "/login", "/workspace", "/connect/oauth", "/p/space-1", "/settings", "/docsx"]) {
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
