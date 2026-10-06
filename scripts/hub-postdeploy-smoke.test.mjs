import assert from "node:assert/strict";
import test from "node:test";

import {
  validateHubCompatibilityResponse,
  validateHubHealthResponse,
  validatePostgresReadinessResponse,
  waitForHubHealth,
} from "./hub-postdeploy-smoke.mjs";

test("post-deploy response must identify the public Hub service", () => {
  assert.deepEqual(
    validateHubHealthResponse({ status: 200 }, { status: "ok", service: "xmatrix-hub" }),
    { status: "ok", service: "xmatrix-hub" },
  );
  assert.throws(
    () => validateHubHealthResponse({ status: 200 }, { status: "ok", service: "web" }),
    /does not identify a healthy xmatrix-hub/,
  );
  assert.throws(
    () => validateHubHealthResponse({ status: 503 }, { status: "ok", service: "xmatrix-hub" }),
    /expected HTTP 200/,
  );
  const revision = "a".repeat(40);
  assert.doesNotThrow(() => validateHubHealthResponse(
    { status: 200 },
    { status: "ok", service: "xmatrix-hub", deployment: { versionId: "version-1", revision } },
    revision,
  ));
  assert.throws(() => validateHubHealthResponse(
    { status: 200 },
    { status: "ok", service: "xmatrix-hub", deployment: { versionId: "version-1", revision } },
    "b".repeat(40),
  ), /expected Hub revision/u);
});

test("post-deploy compatibility responses prove both admission and rejection", () => {
  assert.doesNotThrow(() => validateHubCompatibilityResponse(
    { status: 200 },
    { compatible: true, code: "compatible", retryable: false },
    true,
  ));
  assert.doesNotThrow(() => validateHubCompatibilityResponse(
    { status: 426 },
    { compatible: false, code: "client_upgrade_required", retryable: false },
    false,
  ));
  assert.throws(
    () => validateHubCompatibilityResponse(
      { status: 200 },
      { compatible: false, code: "client_upgrade_required", retryable: false },
      false,
    ),
    /expected compatibility HTTP 426/u,
  );
});

test("PostgreSQL readiness proves the uncached authority client", () => {
  assert.doesNotThrow(() => validatePostgresReadinessResponse(
    { status: 200 },
    { status: "ready", service: "xmatrix-postgres", cacheMode: "disabled" },
  ));
  assert.throws(() => validatePostgresReadinessResponse(
    { status: 200 },
    { status: "ready", service: "xmatrix-postgres", cacheMode: "cached" },
  ), /cache-disabled authority path/u);
});

test("post-deploy smoke retries bounded transient failures", async () => {
  let calls = 0;
  const result = await waitForHubHealth({
    url: "https://xmatrix-hub.example.test/",
    attempts: 3,
    delayMs: 0,
    delayImpl: async () => {},
    fetchImpl: async (url, init) => {
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      if (new URL(url).pathname === "/api/client-compatibility") {
        return compatibilityResponse(init);
      }
      return Response.json({ status: "ok", service: "xmatrix-hub" });
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.attempt, 2);
  assert.equal(result.service, "xmatrix-hub");
  assert.equal(result.compatibility, "enforced");
});

test("Web publication requires the live Hub to admit the exact Web version", async () => {
  const identities = [];
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname !== "/api/client-compatibility") {
      return Response.json({ status: "ok", service: "xmatrix-hub" });
    }
    const headers = new Headers(init.headers);
    const component = headers.get("x-xmatrix-client-component");
    identities.push({ component, version: headers.get("x-xmatrix-client-version") });
    const admitted = component === "cli" || (component === "app" && headers.get("x-xmatrix-client-version") === "0.16.339");
    return Response.json(admitted
      ? { compatible: true, code: "compatible", retryable: false }
      : { compatible: false, code: "client_upgrade_required", retryable: false }, {
      status: admitted ? 200 : 426,
    });
  };
  await waitForHubHealth({
    url: "https://xmatrix-hub.example.test/", attempts: 1, webVersion: "0.16.339", fetchImpl,
  });
  assert.deepEqual(identities.map((item) => item.component), ["cli", "app", null]);
  assert.equal(identities[1].version, "0.16.339");
  await assert.rejects(waitForHubHealth({
    url: "https://xmatrix-hub.example.test/", attempts: 1, webVersion: "0.16.340", fetchImpl,
  }), /expected compatibility HTTP 200/u);
});

test("post-deploy smoke rejects non-HTTPS targets and exhausts its bound", async () => {
  await assert.rejects(
    waitForHubHealth({ url: "http://xmatrix-hub.example.test/" }),
    /must use HTTPS/,
  );
  await assert.rejects(
    waitForHubHealth({
      url: "https://xmatrix-hub.example.test/",
      attempts: 2,
      delayMs: 0,
      delayImpl: async () => {},
      fetchImpl: async () => new Response("no", { status: 503 }),
    }),
    /failed after 2 attempts/,
  );
});

test("Next smoke checks PostgreSQL readiness when explicitly requested", async () => {
  const paths = [];
  const revision = "c".repeat(40);
  const result = await waitForHubHealth({
    url: "https://xmatrix-hub.example.test/",
    attempts: 1,
    postgresReadiness: true,
    expectedSha: revision,
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/api/client-compatibility") {
        return compatibilityResponse(init);
      }
      if (path === "/health/postgres") {
        return Response.json({
          status: "ready",
          service: "xmatrix-postgres",
          cacheMode: "disabled",
        });
      }
      return Response.json({
        status: "ok",
        service: "xmatrix-hub",
        deployment: { versionId: "version-next", revision },
      });
    },
  });
  assert.deepEqual(paths, ["/", "/api/client-compatibility", "/api/client-compatibility", "/health/postgres"]);
  assert.equal(result.postgres, "ready_cache_disabled");
});

function compatibilityResponse(init) {
  const hasIdentity = new Headers(init.headers).has("x-xmatrix-client-component");
  return Response.json(hasIdentity
    ? { compatible: true, code: "compatible", retryable: false }
    : { compatible: false, code: "client_upgrade_required", retryable: false }, {
    status: hasIdentity ? 200 : 426,
  });
}
