/*
 * Outbound provider calls for connector actions. Bounded in time and size,
 * HTTPS only, and never to an address literal, so a configured base URL cannot
 * turn an action into a request to an internal host.
 */

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class ProviderRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export function providerUrl(base: string, path = ""): URL {
  let url: URL;
  try {
    url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  } catch {
    throw new ProviderRequestError(400, "Provider URL is invalid");
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || /^\[|^\d+\.\d+\.\d+\.\d+$/u.test(host) || host === "localhost" ||
      host.endsWith(".localhost") || host.endsWith(".internal") || !host.includes(".")) {
    throw new ProviderRequestError(400, "Provider URL must be a public https host");
  }
  return url;
}

export async function providerJson(url: URL | string, init: RequestInit & { json?: unknown } = {}):
  Promise<Record<string, unknown>> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  headers.set("accept", headers.get("accept") ?? "application/json");
  headers.set("user-agent", "xMatrix-Connectors");
  const response = await fetch(url, { ...rest, headers, redirect: "manual",
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}), signal: rest.signal ? AbortSignal.any([rest.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ProviderRequestError(502, "Provider response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const textBody = new TextDecoder().decode(bytes);
  let parsed: unknown = {};
  try { parsed = textBody ? JSON.parse(textBody) : {}; } catch { parsed = {}; }
  const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : { items: parsed };
  if (!response.ok) {
    const reason = [payload.message, payload.error, payload.error_description, payload.errorMessages, payload.errors]
      .map((value) => Array.isArray(value) ? value.map((item) => typeof item === "string" ? item
        : typeof (item as { message?: unknown })?.message === "string" ? (item as { message: string }).message : "")
        .filter(Boolean).join("; ") : typeof value === "string" ? value : "")
      .find(Boolean) ?? response.statusText;
    throw new ProviderRequestError(response.status, `Provider returned ${response.status}${reason ? `: ${String(reason).slice(0, 200)}` : ""}`);
  }
  return payload;
}
