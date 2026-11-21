/*
 * Bing Webmaster egress relay. Bing answers every Webmaster API call from
 * Cloudflare Workers' shared egress addresses with `ThrottleIP` (ErrorCode
 * 17), whatever the key or call volume, so the Hub sends those calls here and
 * this service makes them from Google Cloud's network instead.
 *
 * It forwards only `https://ssl.bing.com/webmaster/api.svc/json/<Method>`,
 * GET or POST, to a caller that presents the Hub's bearer token. The service
 * holds only the token's SHA-256 (`BING_RELAY_TOKEN_SHA256`), so deploying it
 * never moves a secret. The Bing API key arrives as the `x-bing-apikey`
 * header and is put in Bing's `apikey` query parameter here, so it never
 * appears in a request URL this service is sent or logs.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const BING = "https://ssl.bing.com";
const METHOD_PATH = /^\/webmaster\/api\.svc\/json\/[A-Za-z]{1,64}$/u;
const API_KEY = /^[A-Za-z0-9]{1,200}$/u;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 9_000;

const sha256 = value => createHash("sha256").update(value).digest();
const refuse = (status, message) => Response.json({ ErrorCode: -1, Message: `relay: ${message}` }, { status });

/** The relay as a fetch handler; `fetch` is the outbound call, replaceable in tests. */
export function bingRelay({ tokenSha256, fetch = globalThis.fetch }) {
  if (!/^[a-f0-9]{64}$/u.test(tokenSha256 ?? "")) throw new Error("BING_RELAY_TOKEN_SHA256 must be a lowercase hex SHA-256");
  const expected = Buffer.from(tokenSha256, "hex");
  return async request => {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return new Response("ok");
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token || !timingSafeEqual(sha256(token), expected)) return refuse(401, "unauthorized");
    if (!METHOD_PATH.test(url.pathname) || !["GET", "POST"].includes(request.method)) {
      return refuse(404, "only Bing Webmaster JSON API methods are forwarded");
    }
    const key = request.headers.get("x-bing-apikey") ?? "";
    if (!API_KEY.test(key) || url.searchParams.has("apikey")) return refuse(400, "send the Bing API key only as x-bing-apikey");
    const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : undefined;
    if (body && body.byteLength > MAX_BODY_BYTES) return refuse(413, "request body is too large");
    const target = new URL(url.pathname + url.search, BING);
    target.searchParams.set("apikey", key);
    let upstream;
    try {
      upstream = await fetch(target, { method: request.method, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json", "user-agent": "xMatrix-Connectors", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body } : {}) });
    } catch {
      return refuse(502, "Bing could not be reached");
    }
    const reply = await upstream.arrayBuffer();
    if (reply.byteLength > MAX_REPLY_BYTES) return refuse(502, "Bing's reply is too large");
    return new Response(reply, { status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
  };
}

/** Serve a fetch handler over node:http, reading at most `MAX_BODY_BYTES` of each request. */
export function serve(handler, port) {
  return createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { outgoing.writeHead(413).end(); incoming.destroy(); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
      const hasBody = !["GET", "HEAD"].includes(incoming.method ?? "GET");
      const response = await handler(new Request(`http://relay${incoming.url ?? "/"}`, { method: incoming.method, headers,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}) }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  }).listen(port);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serve(bingRelay({ tokenSha256: process.env.BING_RELAY_TOKEN_SHA256 }), Number(process.env.PORT ?? 8080));
}
