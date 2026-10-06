import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveAuthCookieDomain,
  resolveAuthCookiePrefix,
} from "../src/auth-cookie-domain.ts";

test("hosted production and test deployments use their narrowest shared cookie domain", () => {
  assert.equal(
    resolveAuthCookieDomain({
      APP_URL: "https://xmatrix.sh",
      HUB_URL: "https://xmatrix-hub.xmatrix.sh",
      AUTH_COOKIE_DOMAIN: ".xmatrix.sh",
    }),
    ".xmatrix.sh",
  );
  assert.equal(
    resolveAuthCookieDomain({
      APP_URL: "https://test.xmatrix.sh",
      HUB_URL: "https://xmatrix-hub.test.xmatrix.sh",
      AUTH_COOKIE_DOMAIN: ".test.xmatrix.sh",
    }),
    ".test.xmatrix.sh",
  );
});

test("local development stays host-only when no cookie domain is configured", () => {
  assert.equal(
    resolveAuthCookieDomain({
      APP_URL: "http://localhost:3001",
      HUB_URL: "http://localhost:8787",
    }),
    undefined,
  );
});

test("trusted app and Hub values must be exact origins", () => {
  for (const APP_URL of [
    "https://test.xmatrix.sh/app",
    "https://user@test.xmatrix.sh",
    "javascript:alert(1)",
  ]) {
    assert.throws(
      () => resolveAuthCookieDomain({
        APP_URL,
        HUB_URL: "https://xmatrix-hub.test.xmatrix.sh",
        AUTH_COOKIE_DOMAIN: ".test.xmatrix.sh",
      }),
      /must be an absolute HTTP\(S\) origin/u,
    );
  }
  assert.throws(
    () => resolveAuthCookieDomain({
      APP_URL: "http://test.xmatrix.sh",
      HUB_URL: "https://xmatrix-hub.test.xmatrix.sh",
      AUTH_COOKIE_DOMAIN: ".test.xmatrix.sh",
    }),
    /requires HTTPS/u,
  );
});

test("a test deployment cannot widen cookies into the production domain", () => {
  assert.throws(
    () =>
      resolveAuthCookieDomain({
        APP_URL: "https://test.xmatrix.sh",
        HUB_URL: "https://xmatrix-hub.test.xmatrix.sh",
        AUTH_COOKIE_DOMAIN: ".xmatrix.sh",
      }),
    /narrowest shared/u,
  );
});

test("hosted test auth uses a distinct cookie namespace", () => {
  assert.equal(
    resolveAuthCookiePrefix({
      AUTH_COOKIE_DOMAIN: ".test.xmatrix.sh",
      AUTH_COOKIE_PREFIX: "xmatrix-test",
    }),
    "xmatrix-test",
  );
  assert.equal(resolveAuthCookiePrefix({ AUTH_COOKIE_DOMAIN: ".xmatrix.sh" }), undefined);
  assert.throws(
    () => resolveAuthCookiePrefix({ AUTH_COOKIE_PREFIX: "xmatrix-test" }),
    /requires an explicit AUTH_COOKIE_DOMAIN/u,
  );
  for (const value of ["XMatrix-test", "-xmatrix", "xmatrix_ test", "x".repeat(33)]) {
    assert.throws(
      () => resolveAuthCookiePrefix({
        AUTH_COOKIE_DOMAIN: ".test.xmatrix.sh",
        AUTH_COOKIE_PREFIX: value,
      }),
      /1-32 lowercase/u,
    );
  }
});

test("cookie domains reject unrelated, uppercase, and malformed origins", () => {
  assert.throws(
    () =>
      resolveAuthCookieDomain({
        APP_URL: "https://test.xmatrix.sh",
        HUB_URL: "https://hub.example.com",
        AUTH_COOKIE_DOMAIN: ".xmatrix.sh",
      }),
    /narrowest shared/u,
  );
  assert.throws(
    () =>
      resolveAuthCookieDomain({
        APP_URL: "https://xmatrix.sh",
        HUB_URL: "https://xmatrix-hub.xmatrix.sh",
        AUTH_COOKIE_DOMAIN: ".XMatrix.sh",
      }),
    /lowercase dotted DNS suffix/u,
  );
  assert.throws(
    () =>
      resolveAuthCookieDomain({
        APP_URL: "not a url",
        HUB_URL: "https://xmatrix-hub.xmatrix.sh",
        AUTH_COOKIE_DOMAIN: ".xmatrix.sh",
      }),
    /absolute HTTP\(S\) origin/u,
  );
});
