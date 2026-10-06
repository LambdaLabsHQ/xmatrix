/** Enforce TLS before auth, routing, body reads, or WebSocket upgrades. */
export function redirectInsecureRequest(request: Request): Response | null {
  const url = new URL(request.url);
  // Loopback and dot-less hosts (localhost, wrangler's `placeholder`) are never public.
  if (url.protocol !== "http:" || url.hostname === "127.0.0.1" || !url.hostname.includes(".")) return null;
  // Request.url is the edge transport authority; never trust forwarded headers.
  url.protocol = "https:";
  return Response.redirect(url.href, 308);
}
