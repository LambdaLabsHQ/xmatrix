import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { MAX_REQUEST_BODY_BYTES, registerRequestBodyLimit } from "../src/request-body-limit.ts";
import { RELAY_R2_UPLOAD_PREFIX } from "../src/relay-r2-upload-private-api.ts";

function app() {
  const hono = new Hono();
  registerRequestBodyLimit(hono);
  hono.post("/api/echo", async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  hono.put(`${RELAY_R2_UPLOAD_PREFIX}/:id`, async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  return hono;
}

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
