import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

import { resolveAuthCookieDomain } from "../src/auth-cookie-domain.ts";
import { registerDirectReadCors } from "../src/direct-read-cors.ts";
import { authCorsOrigin } from "../src/index-shared.ts";

const env = {
  APP_URL: "https://xmatrix.sh",
  APP_BETA_URL: "https://beta.xmatrix.sh",
  HUB_URL: "https://xmatrix-hub.xmatrix.sh",
  AUTH_COOKIE_DOMAIN: ".xmatrix.sh",
};
// Origins a hostile page can send: lookalike hosts, another scheme or port, a sibling subdomain.
const strangers = [
  "https://beta.xmatrix.sh.evil.example",
  "https://evilbeta.xmatrix.sh",
  "http://beta.xmatrix.sh",
  "https://beta.xmatrix.sh:8443",
  "https://preview.xmatrix.sh",
  "null",
];

const fromOrigin = (origin, init = {}) =>
  new Request("https://xmatrix-hub.xmatrix.sh/api/auth/get-session", { ...init, headers: { origin, ...init.headers } });

test("the credentialed auth gate answers the stable and beta Web exactly, and nothing else", () => {
  assert.equal(authCorsOrigin(fromOrigin("https://xmatrix.sh"), env), "https://xmatrix.sh");
  assert.equal(authCorsOrigin(fromOrigin("https://beta.xmatrix.sh"), env), "https://beta.xmatrix.sh");
  for (const origin of strangers) assert.equal(authCorsOrigin(fromOrigin(origin), env), null, origin);
  // A deployment without a beta Web keeps its single origin.
  assert.equal(authCorsOrigin(fromOrigin("https://beta.xmatrix.sh"), { ...env, APP_BETA_URL: undefined }), null);
});

test("direct reads answer the beta Web's preflight with its own origin, and no stranger's", async () => {
  const app = new Hono();
  registerDirectReadCors(app);
  const preflight = (origin) => app.request("/api/channels/channel-1/history", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "GET" },
  }, env);
  const beta = await preflight("https://beta.xmatrix.sh");
  assert.equal(beta.status, 204);
  assert.equal(beta.headers.get("access-control-allow-origin"), "https://beta.xmatrix.sh");
  assert.equal(beta.headers.get("access-control-allow-credentials"), null, "direct reads never carry cookies");
  for (const origin of strangers) {
    assert.equal((await preflight(origin)).headers.get("access-control-allow-origin"), null, origin);
  }
});

test("the beta Web shares the session only from inside the cookie domain", () => {
  assert.equal(resolveAuthCookieDomain(env), ".xmatrix.sh");
  for (const APP_BETA_URL of ["https://beta.xmatrix.example", "http://beta.xmatrix.sh"]) {
    assert.throws(() => resolveAuthCookieDomain({ ...env, APP_BETA_URL }), /APP_BETA_URL must be an HTTPS origin inside/u);
  }
});

test("the Web uploads a file's bytes straight, with its checksum, and only into an intent's scope", async () => {
  const app = new Hono();
  registerDirectReadCors(app);
  const preflight = (path, method = "PUT") => app.request(path, {
    method: "OPTIONS",
    headers: { origin: "https://xmatrix.sh", "access-control-request-method": method },
  }, env);
  const upload = await preflight("/api/relay-v2/private-r2/uploads/intent-1/scope/space%3Aspace-1");
  assert.equal(upload.status, 204);
  assert.equal(upload.headers.get("access-control-allow-origin"), "https://xmatrix.sh");
  assert.equal(upload.headers.get("access-control-allow-methods"), "PUT");
  assert.match(upload.headers.get("access-control-allow-headers"), /x-xmatrix-content-sha256/u);
  for (const path of ["/api/relay-v2/private-r2/uploads/intent-1", "/api/relay-v2/private-r2/uploads/intent-1/staging/scope/s"]) {
    assert.equal((await preflight(path)).headers.get("access-control-allow-origin"), null, path);
  }
  assert.equal((await preflight("/api/relay-v2/private-r2/uploads/intent-1/scope/s", "POST"))
    .headers.get("access-control-allow-origin"), null);
});
