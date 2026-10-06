import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RELAY_R2_UPLOAD_PREFIX } from "./relay-r2-upload-private-api";
import type { Env } from "./types";

/**
 * The largest request body any Hub route reads into memory. Routes parse
 * bodies whole, so an unbounded one could exhaust the Worker isolate shared
 * with other requests. Attachment uploads stream straight to R2 and keep
 * their own, larger bound.
 */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

export function registerRequestBodyLimit(app: Hono<{ Bindings: Env }>): void {
  const limit = bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c) => c.json({ error: "Request body is too large", code: "request_too_large", retryable: false }, 413),
  });
  app.use("*", async (c, next) => {
    if (c.req.method === "PUT" && c.req.path.startsWith(`${RELAY_R2_UPLOAD_PREFIX}/`)) return next();
    return limit(c, next);
  });
}
