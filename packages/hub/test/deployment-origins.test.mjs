import assert from "node:assert/strict";
import { test } from "node:test";

import { appOrigin, deploymentOrigin, hubAuthBaseUrl } from "../src/deployment-origins.ts";

test("deployment origins come only from configuration", () => {
  assert.equal(appOrigin({ APP_URL: "https://example.com/" }), "https://example.com");
  assert.equal(hubAuthBaseUrl({ HUB_URL: " https://hub.example.com " }), "https://hub.example.com");
  assert.equal(appOrigin({ APP_URL: "http://localhost:3001" }), "http://localhost:3001");
  assert.throws(() => appOrigin({}), /APP_URL is not configured/u);
  assert.throws(() => hubAuthBaseUrl({ HUB_URL: "  " }), /HUB_URL is not configured/u);
});

test("an origin carries no credentials, path, query or fragment", () => {
  for (const value of ["example.com", "ftp://example.com", "https://u@example.com", "https://example.com/app", "https://example.com/?x", "https://example.com/#x"]) {
    assert.throws(() => deploymentOrigin(value, "APP_URL"), /APP_URL must be an absolute HTTP\(S\) origin/u, value);
  }
});
