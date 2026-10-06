const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

export type JsonObjectDecodeResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** Semantics-free WebSocket frame decoding shared through composition. */
export function decodeBoundedJsonObject(
  frame: string | ArrayBuffer,
  maxBytes = DEFAULT_MAX_JSON_BYTES
): JsonObjectDecodeResult {
  const bytes = typeof frame === "string" ? new TextEncoder().encode(frame) : new Uint8Array(frame);
  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: "JSON payload is too large" };
  }

  const text = typeof frame === "string" ? frame : new TextDecoder().decode(frame);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON payload" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Invalid connection message" };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
