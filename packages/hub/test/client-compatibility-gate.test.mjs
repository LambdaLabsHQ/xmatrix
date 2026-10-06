import assert from "node:assert/strict";

import { test } from "node:test";
import { Hono } from "hono";

import * as gate from "../src/client-compatibility-gate.ts";

function appWithProtectedRoute(calls, env = {}) {
  const app = new Hono();
  gate.registerClientCompatibilityGate(app);
  app.get("/api/channels", (context) => {
    calls.push("route");
    return context.json({ reached: true });
  });
  return { app, env };
}

test("old and unidentified bearer clients are rejected before route work", async () => {
  for (const headers of [
    { authorization: "Bearer token" },
    {
      authorization: "Bearer token",
      "x-xmatrix-client-component": "cli",
      "x-xmatrix-client-version": "0.15.52",
      "x-xmatrix-client-protocol": "1",
    },
  ]) {
    const calls = [];
    const { app, env } = appWithProtectedRoute(calls);
    const response = await app.request("https://hub.test/api/channels", { headers }, env);
    assert.equal(response.status, 426);
    assert.deepEqual(calls, []);
    const body = await response.json();
    assert.equal(body.code, "client_upgrade_required");
    assert.equal(body.retryable, false);
  }
});

test("compatible clients pass and auth recovery stays reachable", async () => {
  const calls = [];
  const { app, env } = appWithProtectedRoute(calls);
  const response = await app.request("https://hub.test/api/channels", {
    headers: {
      authorization: "Bearer token",
      "x-xmatrix-client-component": "cli",
      "x-xmatrix-client-version": "0.16.698",
      "x-xmatrix-client-protocol": "2",
    },
  }, env);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["route"]);
  assert.equal(gate.clientCompatibilityRequired(new Request(
    "https://hub.test/api/auth/cli/device/start",
    { headers: { authorization: "Bearer token" } },
  )), false);
});

test("the explicit legacy lane admits only wholly unidentified requests", async () => {
  const calls = [];
  const { app, env } = appWithProtectedRoute(calls, {
    CLIENT_COMPATIBILITY_LEGACY_ADMISSION_ENABLED: "true",
  });
  const admitted = await app.request("https://hub.test/api/channels", {
    headers: { authorization: "Bearer token" },
  }, env);
  assert.equal(admitted.status, 200);
  assert.deepEqual(calls, ["route"]);

  const rejected = await app.request("https://hub.test/api/channels", {
    headers: {
      authorization: "Bearer token",
      "x-xmatrix-client-component": "daemon",
    },
  }, env);
  assert.equal(rejected.status, 426);
  assert.deepEqual(calls, ["route"]);
});

test("every socket domain requires compatibility before a Runtime Durable Object lookup", async () => {
  for (const path of [
    "/ws/humans",
    "/ws/agent-instances",
    "/ws/machine-daemons",
    "/ws/relay-v2-runtime",
  ]) {
    assert.equal(gate.clientCompatibilityRequired(new Request(
      `https://hub.test${path}`,
      { headers: { upgrade: "websocket" } },
    )), true, path);
  }

  const browserUrl = new URL("https://hub.test/ws/humans");
  browserUrl.searchParams.set("x-xmatrix-client-component", "app");
  browserUrl.searchParams.set("x-xmatrix-client-version", "0.16.698");
  browserUrl.searchParams.set("x-xmatrix-client-protocol", "2");
  assert.equal(
    gate.clientCompatibilityDecisionForRequest(new Request(browserUrl)).compatible,
    true,
  );
});
