import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { verifyHttpsRedirect } from "./https-postdeploy-smoke.mjs";
import { loadProfile, renderComponent, resolveProfile } from "./deploy-config.mjs";

const source = await readFile(new URL("../packages/hub/src/https-redirect.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { redirectInsecureRequest } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("Hub rejects insecure processing before auth, including spoofed forwarding and upgrades", () => {
  for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
    const request = new Request("http://xmatrix-hub.xmatrix.sh/api/auth/a%2Fb?q=x%2Fy&n=1", {
      method, headers: { "x-forwarded-proto": "https", upgrade: "websocket" },
    });
    const response = redirectInsecureRequest(request);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "https://xmatrix-hub.xmatrix.sh/api/auth/a%2Fb?q=x%2Fy&n=1");
  }
  for (const url of ["https://xmatrix-hub.xmatrix.sh/", "http://localhost:8787/", "http://127.0.0.1:8787/", "http://[::1]:8787/", "http://placeholder/api/x?y=1"]) {
    assert.equal(redirectInsecureRequest(new Request(url)), null);
  }
});

/** The Web's worker.mjs, with the modules it imports, over a stub OpenNext handler in a temporary directory. */
async function webWorkerFixture(prefix, openNextSource) {
  const dir = await mkdtemp(`${tmpdir()}/${prefix}`);
  await mkdir(`${dir}/.open-next`);
  await writeFile(`${dir}/.open-next/worker.js`, openNextSource);
  await writeFile(`${dir}/package.json`, '{"type":"module"}');
  for (const file of ["worker.mjs", "site-host.mjs"]) {
    await writeFile(`${dir}/${file}`, await readFile(new URL(`../apps/web/${file}`, import.meta.url)));
  }
  return dir;
}

test("Web redirects before assets or OpenNext and preserves secure routing", async () => {
  const dir = await webWorkerFixture("xmatrix-https-",
    'export const sentinel = 1; export default { fetch: () => new Response("app") };');
  try {
    const { default: worker, sentinel } = await import(pathToFileURL(`${dir}/worker.mjs`));
    assert.equal(sentinel, 1);
    for (const path of ["/", "/favicon.ico", "/_next/static/a.js", "/api/auth?q=a%2Fb"]) {
      for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
        const response = await worker.fetch(new Request(`http://xmatrix.sh${path}`, { method, headers: { "x-forwarded-proto": "https" } }), {}, {});
        assert.equal(response.status, 308);
        assert.equal(response.headers.get("location"), `https://xmatrix.sh${path}`);
      }
    }
    for (const method of ["GET", "HEAD"]) {
      for (const [path, status, immutable] of [
        ["/_next/static/chunks/main-app-0123456789abcdef.js", 200, true],
        ["/_next/static/chunks/app/workspace/page-0123456789abcdef.js", 304, true],
        ["/_next/static/css/0123456789abcdef.css", 200, true],
        ["/_next/static/chunks/main-app-0123456789abcdef.js", 500, false],
        ["/_next/static/chunks/main-app-0123456789abcdef.js", 302, false],
        ["/_next/static/chunks/main-app.js", 200, false],
        ["/_next/static/development/_buildManifest.js", 200, false],
        ["/app", 200, false],
        ["/api/auth/token", 200, false],
        ["/api/version", 200, false],
        ["/public-0123456789abcdef.js", 200, false],
      ]) {
        const original = new Response(status === 304 ? null : "asset", {
          status, headers: { "cache-control": "public, max-age=0, must-revalidate", etag: '"asset-hash"' },
        });
        const response = await worker.fetch(new Request(`https://xmatrix.sh${path}`, { method }), {
          ASSETS: { fetch: async () => original },
        }, {});
        assert.equal(response.status, status);
        assert.equal(response.headers.get("etag"), '"asset-hash"');
        assert.equal(response.headers.get("cache-control"), immutable
          ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate", path);
        if (status !== 304) assert.equal(await response.text(), "asset");
      }
    }
    const env = { ASSETS: { fetch: async (r) => new Response("asset", { status: r.url.endsWith(".ico") ? 200 : 404 }) } };
    assert.equal(await (await worker.fetch(new Request("https://xmatrix.sh/favicon.ico"), env, {})).text(), "asset");
    assert.equal(await (await worker.fetch(new Request("https://xmatrix.sh/app"), env, {})).text(), "app");
    assert.equal(await (await worker.fetch(new Request("http://localhost:3001/app"), env, {})).text(), "app");
    assert.equal(await (await worker.fetch(new Request("http://placeholder/app"), env, {})).text(), "app");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Web sends anything but the site at the site origin to the app origin, after the TLS guard and before assets", async () => {
  const dir = await webWorkerFixture("xmatrix-site-", 'export default { fetch: () => new Response("app") };');
  try {
    const { default: worker } = await import(pathToFileURL(`${dir}/worker.mjs`));
    const assets = { fetch: async () => new Response("asset") };
    const env = { ASSETS: assets, XMATRIX_SITE_ORIGIN: "https://xmatrix.page", XMATRIX_APP_ORIGIN: "https://xmatrix.sh" };
    const insecure = await worker.fetch(new Request("http://xmatrix.page/app"), env, {});
    assert.equal(insecure.status, 308);
    assert.equal(insecure.headers.get("location"), "https://xmatrix.page/app");
    const app = await worker.fetch(new Request("https://xmatrix.page/app/space?x=1"), env, {});
    assert.equal(app.status, 302);
    assert.equal(app.headers.get("location"), "https://xmatrix.sh/app/space?x=1");
    assert.equal(await (await worker.fetch(new Request("https://xmatrix.page/docs/setup"), env, {})).text(), "asset");
    assert.equal(await (await worker.fetch(new Request("https://xmatrix.sh/app"), env, {})).text(), "asset");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Web makes every cache revalidate prerendered pages", async () => {
  const dir = await webWorkerFixture("xmatrix-prerendered-", `export default { fetch: (request) => {
      const path = new URL(request.url).pathname;
      const cacheControl = path === "/app" ? "s-maxage=31536000, stale-while-revalidate=2592000"
        : path === "/" ? "s-maxage=31536000" : "private, no-cache, no-store, max-age=0, must-revalidate";
      return new Response("page:" + path, { headers: { "cache-control": cacheControl, etag: "page-hash", "x-opennext-cache": "HIT" } });
    } };`);
  try {
    const { default: worker } = await import(pathToFileURL(`${dir}/worker.mjs`));
    for (const [path, cacheControl] of [
      ["/app", "public, max-age=0, must-revalidate"],
      ["/", "public, max-age=0, must-revalidate"],
      ["/app/space/channels/general--1", "private, no-cache, no-store, max-age=0, must-revalidate"],
    ]) {
      const response = await worker.fetch(new Request(`https://xmatrix.sh${path}`, { headers: { rsc: "1" } }), {
        ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
      }, {});
      assert.equal(response.headers.get("cache-control"), cacheControl, path);
      assert.equal(response.headers.get("etag"), "page-hash");
      assert.equal(await response.text(), `page:${path}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the rendered Web config runs the TLS guard before static assets", async () => {
  const config = JSON.parse(await renderComponent("web", resolveProfile(await loadProfile("ci"))));
  assert.equal(config.main, "worker.mjs");
  assert.equal(config.assets.run_worker_first, true);
});

test("smoke fails closed on HTTP 200, wrong redirects and network failures", async () => {
  for (const response of [new Response("ok"), Response.redirect("https://evil.example/", 308), Response.redirect("https://xmatrix.sh/", 308)]) {
    await assert.rejects(verifyHttpsRedirect("https://xmatrix.sh", async () => response));
  }
  await assert.rejects(verifyHttpsRedirect("https://xmatrix.sh", async () => { throw new Error("offline"); }));
  await verifyHttpsRedirect("https://xmatrix.sh", async (url, options) => {
    assert.equal(options.redirect, "manual");
    assert.equal(url.protocol, "http:");
    return Response.redirect(url.href.replace("http:", "https:"), 308);
  });
});
