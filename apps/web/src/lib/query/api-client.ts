import { DEFAULT_HUB_URL, normalizeHubUrl } from "@xmatrix/protocol";

export interface XMatrixErrorPayload {
  error?: string;
  message?: string;
  code?: string;
  retryable?: boolean;
  details?: unknown;
}

export class XMatrixApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  /** The server's Retry-After, when it named one. */
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(input: {
    message: string;
    status: number;
    code?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "XMatrixApiError";
    this.status = input.status;
    this.code = input.code || "request_failed";
    this.retryable = input.retryable === true;
    this.retryAfterMs = input.retryAfterMs;
    this.details = input.details;
  }
}

export class XMatrixRawResponseError extends XMatrixApiError {
  readonly response: Response;

  constructor(response: Response, error: XMatrixApiError) {
    super({
      message: error.message,
      status: error.status,
      code: error.code,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      details: error.details,
    });
    this.name = "XMatrixRawResponseError";
    this.response = response;
  }
}

export function xmatrixHubOrigin(): string {
  try {
    return new URL(normalizeHubUrl(
      process.env.NEXT_PUBLIC_XMATRIX_HUB_URL || DEFAULT_HUB_URL,
    )).origin;
  } catch {
    return "xmatrix-hub";
  }
}

/** Statuses a gateway in front of the Hub answers while the Hub restarts or is unreachable. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30_000;

/** Retry-After as delta-seconds or an HTTP date, in milliseconds from now. */
export function retryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const ms = /^\d+(?:\.\d+)?$/u.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * A failed response as the one error every client path classifies. The Hub
 * labels its own failures `retryable`; a gateway status without the Hub's
 * error body never reached the Hub's logic, so it is transient too.
 */
export async function errorFromResponse(response: Response): Promise<XMatrixApiError> {
  const payload = await response.clone().json().catch(() => ({})) as XMatrixErrorPayload;
  const fromHub = typeof payload.code === "string" || typeof payload.retryable === "boolean";
  return new XMatrixApiError({
    message: payload.error || payload.message || `Request failed (${response.status})`,
    status: response.status,
    code: payload.code,
    retryable: fromHub ? payload.retryable : GATEWAY_STATUSES.has(response.status),
    retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
    details: payload.details,
  });
}

/**
 * A request that got no answer. The caller ending it (its abort or its own
 * deadline) is the caller's outcome and passes through unchanged; anything
 * else is the network, and transient.
 */
function throwTransportError(cause: unknown, signal: AbortSignal | null | undefined): never {
  if (signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) throw cause;
  throw new XMatrixApiError({
    message: cause instanceof Error ? cause.message : "Network request failed",
    status: 0,
    code: "network_error",
    retryable: true,
  });
}

export async function xmatrixApiRequest<T>(input: {
  url: string;
  token?: string;
  method?: string;
  body?: unknown;
  rawBody?: BodyInit;
  signal?: AbortSignal;
  headers?: HeadersInit;
}): Promise<T> {
  if (input.body !== undefined && input.rawBody !== undefined) {
    throw new TypeError("xMatrix request cannot contain both JSON and raw bodies");
  }
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: input.method,
      headers: {
        ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...input.headers,
      },
      ...(input.body === undefined
        ? (input.rawBody === undefined ? {} : { body: input.rawBody })
        : { body: JSON.stringify(input.body) }),
      signal: input.signal,
      cache: "no-store",
    });
  } catch (cause) {
    throwTransportError(cause, input.signal);
  }
  if (!response.ok) throw await errorFromResponse(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Raw-response transport for compatibility call sites while they move their
 * parsing into typed domain fetchers. React code must reach it through the
 * Query-backed hook, never call the browser global directly. */
export async function xmatrixRawResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, { cache: "no-store", ...init });
  } catch (cause) {
    throwTransportError(cause, init?.signal ?? (input instanceof Request ? input.signal : undefined));
  }
}

/** Makes retryable HTTP responses visible to Query without changing the raw
 * Response contract of compatibility consumers. The bridge returns the final
 * failed Response after Query exhausts its bounded retries. */
export async function xmatrixQueryRawResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await xmatrixRawResponse(input, init);
  if (!response.ok) {
    const error = await errorFromResponse(response);
    if (shouldRetryXMatrixQuery(0, error)) {
      throw new XMatrixRawResponseError(response, error);
    }
  }
  return response;
}

/**
 * The one client rule for a failure worth replaying (docs/architecture/client-resilience.md):
 * the request never got an answer, the server asked us to slow down, or the
 * server said the failure is transient. Anything else is a real answer.
 */
export function isTransientFailure(error: unknown): boolean {
  if (!(error instanceof XMatrixApiError)) return false;
  if (error.status === 0 || error.status === 408 || error.status === 429) return true;
  return error.status >= 500 && error.retryable;
}

export function shouldRetryXMatrixQuery(failureCount: number, error: unknown): boolean {
  return failureCount < 2 && isTransientFailure(error);
}

/** The server's Retry-After when it named one, else jittered exponential backoff. */
export function xmatrixRetryDelayMs(failureCount: number, error: unknown): number {
  if (error instanceof XMatrixApiError && error.retryAfterMs !== undefined) return error.retryAfterMs;
  const ceiling = Math.min(MAX_RETRY_AFTER_MS, 1_000 * 2 ** failureCount);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/** Preserve the plain Error contract of raw-response command consumers. */
export async function requireResponseOk(response: Response, fallback: string, ignoredStatus?: number): Promise<void> {
  if (response.ok || response.status === ignoredStatus) return;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(payload.error || fallback);
}
