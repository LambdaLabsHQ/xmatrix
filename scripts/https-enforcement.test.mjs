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

test("Web redirects before assets or OpenNext and preserves secure routing", async () => {
  const dir = await mkdtemp(`${tmpdir()}/xmatrix-https-`);
  try {
    await mkdir(`${dir}/.open-next`);
    await writeFile(`${dir}/.open-next/worker.js`, 'export const sentinel = 1; export default { fetch: () => new Response("app") };');
    await writeFile(`${dir}/package.json`, '{"type":"module"}');
    await writeFile(`${dir}/worker.mjs`, await readFile(new URL("../apps/web/worker.mjs", import.meta.url)));
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
