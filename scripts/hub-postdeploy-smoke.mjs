#!/usr/bin/env node

import process from "node:process";
import fs from "node:fs";

import { runCliMain } from "./cli-entrypoint.mjs";

const compatibilityPolicy = JSON.parse(fs.readFileSync(
  new URL("../packages/protocol/src/client-compatibility-policy.json", import.meta.url),
  "utf8",
));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function validateHubHealthResponse(response, payload, expectedSha) {
  if (!response || response.status !== 200) {
    throw new Error(`expected HTTP 200, received ${response?.status ?? "no response"}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("health response must be a JSON object");
  }
  if (payload.status !== "ok" || payload.service !== "xmatrix-hub") {
    throw new Error("health response does not identify a healthy xmatrix-hub service");
  }
  if (expectedSha !== undefined) {
    if (!/^[0-9a-f]{40}$/u.test(expectedSha)) {
      throw new Error("expected Hub revision must be a full Git SHA");
    }
    if (payload.deployment?.revision !== expectedSha ||
        typeof payload.deployment?.versionId !== "string" ||
        payload.deployment.versionId.length === 0) {
      throw new Error("health response does not identify the expected Hub revision");
    }
  }
  return { status: payload.status, service: payload.service };
}

export function validateHubCompatibilityResponse(response, payload, compatible) {
  const expectedStatus = compatible ? 200 : 426;
  if (!response || response.status !== expectedStatus) {
    throw new Error(
      `expected compatibility HTTP ${expectedStatus}, received ${response?.status ?? "no response"}`,
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("compatibility response must be a JSON object");
  }
  if (
    payload.compatible !== compatible ||
    payload.code !== (compatible ? "compatible" : "client_upgrade_required") ||
    payload.retryable !== false
  ) {
    throw new Error("compatibility response does not enforce the terminal client policy");
  }
  return payload;
}

export function validatePostgresReadinessResponse(response, payload) {
  if (!response || response.status !== 200) {
    throw new Error(`expected PostgreSQL readiness HTTP 200, received ${response?.status ?? "no response"}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("PostgreSQL readiness response must be a JSON object");
  }
  if (
    payload.status !== "ready" ||
    payload.service !== "xmatrix-postgres" ||
    payload.cacheMode !== "disabled"
  ) {
    throw new Error("PostgreSQL readiness did not prove the cache-disabled authority path");
  }
  return payload;
}

async function fetchNoCacheJson(target, fetchImpl, label) {
  const response = await fetchImpl(target, {
    method: "GET",
    redirect: "error",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${label} response content type is not JSON`);
  }
  return { response, payload: await response.json() };
}

async function verifyPostgresReadiness(target, fetchImpl) {
  const endpoint = new URL("/health/postgres", target);
  const { response, payload } = await fetchNoCacheJson(
    endpoint, fetchImpl, "PostgreSQL readiness",
  );
  return validatePostgresReadinessResponse(response, payload);
}

async function verifyCompatibilityGate(target, fetchImpl, webVersion, cliVersion) {
  const endpoint = new URL("/api/client-compatibility", target);
  const admittedResponse = await fetchImpl(endpoint, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      "x-xmatrix-client-component": "cli",
      "x-xmatrix-client-version": compatibilityPolicy.minimumVersions.cli,
      "x-xmatrix-client-protocol": String(compatibilityPolicy.protocolVersion),
    },
    signal: AbortSignal.timeout(10_000),
  });
  validateHubCompatibilityResponse(
    admittedResponse,
    await admittedResponse.json(),
    true,
  );

  if (cliVersion !== undefined) {
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(cliVersion)) {
      throw new Error("CLI compatibility version must be a stable semantic version");
    }
    const cliResponse = await fetchImpl(endpoint, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "x-xmatrix-client-component": "cli",
        "x-xmatrix-client-version": cliVersion,
        "x-xmatrix-client-protocol": String(compatibilityPolicy.protocolVersion),
      },
      signal: AbortSignal.timeout(10_000),
    });
    validateHubCompatibilityResponse(cliResponse, await cliResponse.json(), true);
  }

  if (webVersion !== undefined) {
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(webVersion)) {
      throw new Error("Web compatibility version must be a stable semantic version");
    }
    const webResponse = await fetchImpl(endpoint, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "x-xmatrix-client-component": "app",
        "x-xmatrix-client-version": webVersion,
        "x-xmatrix-client-protocol": String(compatibilityPolicy.protocolVersion),
      },
      signal: AbortSignal.timeout(10_000),
    });
    validateHubCompatibilityResponse(webResponse, await webResponse.json(), true);
  }

  const missingResponse = await fetchImpl(endpoint, {
    method: "GET",
    redirect: "error",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  validateHubCompatibilityResponse(
    missingResponse,
    await missingResponse.json(),
    false,
  );
}

export async function waitForHubHealth({
  url,
  attempts = 12,
  delayMs = 5_000,
  fetchImpl = fetch,
  delayImpl = delay,
  postgresReadiness = false,
  expectedSha,
  webVersion,
  cliVersion,
}) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("post-deploy smoke URL must use HTTPS");
  if (!Number.isSafeInteger(attempts) || attempts <= 0 || attempts > 60) {
    throw new Error("attempts must be an integer between 1 and 60");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
    throw new Error("delayMs must be an integer between 0 and 30000");
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { response, payload } = await fetchNoCacheJson(target, fetchImpl, "health");
      const health = validateHubHealthResponse(response, payload, expectedSha);
      await verifyCompatibilityGate(target, fetchImpl, webVersion, cliVersion);
      if (postgresReadiness) await verifyPostgresReadiness(target, fetchImpl);
      return {
        ...health,
        compatibility: "enforced",
        postgres: postgresReadiness ? "ready_cache_disabled" : "not_checked",
        attempt,
        url: target.toString(),
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delayImpl(delayMs);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Hub post-deploy smoke failed after ${attempts} attempts: ${detail}`);
}

function argumentValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index >= 0 && index < argv.length - 1 ? argv[index + 1] : fallback;
}

async function main(argv = process.argv.slice(2)) {
  const url = argumentValue(argv, "--url");
  if (!url) {
    throw new Error(
      "usage: hub-postdeploy-smoke.mjs --url <https-url> [--attempts n] [--delay-ms n] [--postgres-readiness] [--expected-sha sha] [--web-version version] [--cli-version version]",
    );
  }
  const result = await waitForHubHealth({
    url,
    attempts: Number(argumentValue(argv, "--attempts", "12")),
    delayMs: Number(argumentValue(argv, "--delay-ms", "5000")),
    postgresReadiness: argv.includes("--postgres-readiness"),
    expectedSha: argumentValue(argv, "--expected-sha"),
    webVersion: argumentValue(argv, "--web-version"),
    cliVersion: argumentValue(argv, "--cli-version"),
  });
  console.log(
    `[hub-postdeploy] healthy service=${result.service} status=${result.status} compatibility=${result.compatibility} postgres=${result.postgres} attempt=${result.attempt}`,
  );
}

runCliMain(import.meta.url, main);
