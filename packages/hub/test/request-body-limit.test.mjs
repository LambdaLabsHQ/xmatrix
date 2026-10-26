import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { MAX_REQUEST_BODY_BYTES, registerRequestBodyLimit } from "../src/request-body-limit.ts";
import { RELAY_R2_UPLOAD_PREFIX } from "../src/relay-r2-upload-private-api.ts";

function app() {
  const hono = new Hono();
  registerRequestBodyLimit(hono);
  hono.post("/api/echo", async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  hono.post("/api/auth/oauth2/register", async (c) => c.json({ body: await c.req.raw.json() }));
  hono.post("/api/auth/oauth2/token", async (c) => c.text(await c.req.raw.text()));
  hono.put(`${RELAY_R2_UPLOAD_PREFIX}/:id`, async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  return hono;
}

const AUTH_LIMIT_BYTES = 64 * 1024;

const over = () => new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);

test("a body within the limit reaches the route", async () => {
  const response = await app().request("/api/echo", { method: "POST", body: new Uint8Array(1024) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { bytes: 1024 });
});

test("an oversized body is refused before the route reads it", async () => {
  const response = await app().request("/api/echo", { method: "POST", body: over() });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "request_too_large");
});

test("an oversized chunked body without Content-Length is refused too", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent > MAX_REQUEST_BODY_BYTES) return controller.close();
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const response = await app().request("/api/echo", { method: "POST", body, duplex: "half" });
  assert.equal(response.status, 413);
});

test("attachment uploads keep their own, larger bound", async () => {
  const response = await app().request(`${RELAY_R2_UPLOAD_PREFIX}/intent-1`, { method: "PUT", body: over() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { bytes: MAX_REQUEST_BODY_BYTES + 1 });
});

// The public authentication schema includes unbounded collections. Its owner
// middleware must refuse large input before the raw Better Auth handler reads it;
// the general 4 MiB tests above cannot protect this smaller boundary.
test("authentication rejects large collections below the general body limit", async () => {
  const body = JSON.stringify({ redirect_uris: Array(AUTH_LIMIT_BYTES / 2).fill(0) });
  assert.ok(Buffer.byteLength(body) < MAX_REQUEST_BODY_BYTES);
  const response = await app().request("/api/auth/oauth2/register", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "Request body is too large", code: "request_too_large", retryable: false,
  });
});

test("authentication counts real UTF-8 bytes and cancels an oversized stream despite a small Content-Length", async () => {
  let cancelled = false;
  let pulls = 0;
  const chunk = new TextEncoder().encode("界".repeat(AUTH_LIMIT_BYTES / 4));
  assert.ok(chunk.length > AUTH_LIMIT_BYTES / 2);
  const body = new ReadableStream({
    pull(controller) {
      if (pulls === 3) return controller.close();
      pulls += 1; controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  });
  const response = await app().request("/api/auth/oauth2/register", {
    method: "POST", headers: { "content-length": "1", "content-type": "application/json" }, body, duplex: "half",
  });
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3, "stops reading when the bound is crossed");
});

test("authentication preserves a valid raw JSON body and its inclusive byte boundary", async () => {
  const value = { client_name: "App", redirect_uris: ["https://client.example/callback"] };
  const body = JSON.stringify(value).padEnd(AUTH_LIMIT_BYTES, " ");
  const response = await app().request("/api/auth/oauth2/register", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { body: value });
});

test("authentication preserves OAuth form bytes for the raw handler", async () => {
  const body = "grant_type=authorization_code&code=a%2Bb&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback";
  const response = await app().request("/api/auth/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), body);
});
