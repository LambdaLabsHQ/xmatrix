/** Private API JSON is never cached or interpreted as executable content. */
export const PRIVATE_JSON_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
} as const;

export function privateJsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: PRIVATE_JSON_HEADERS });
}
