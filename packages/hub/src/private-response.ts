/**
 * Passing a product response on to the caller. Kept out of index-shared so any
 * module can import it without pulling in Worker-only bindings.
 */

/**
 * Pass a response on to the caller: its body and status, its content type
 * (JSON when it names none), and any `headers` the route adds or overrides.
 */
export function relayResponse(response: Response, headers: Record<string, string> = {}): Response {
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json", ...headers },
  });
}

/** The same response, uncached, keeping any Retry-After. */
export function privateResponse(response: Response): Response {
  const retryAfter = response.headers.get("retry-after");
  return relayResponse(response, {
    "cache-control": "private, no-store",
    ...(retryAfter ? { "retry-after": retryAfter } : {}),
  });
}
