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
  readonly details?: unknown;

  constructor(input: {
    message: string;
    status: number;
    code?: string;
    retryable?: boolean;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "XMatrixApiError";
    this.status = input.status;
    this.code = input.code || "request_failed";
    this.retryable = input.retryable === true;
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

async function errorFromResponse(response: Response): Promise<XMatrixApiError> {
  const payload = await response.clone().json().catch(() => ({})) as XMatrixErrorPayload;
  return new XMatrixApiError({
    message: payload.error || payload.message || `Request failed (${response.status})`,
    status: response.status,
    code: payload.code,
    retryable: payload.retryable,
    details: payload.details,
  });
}

function throwTransportError(cause: unknown): never {
  if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
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
    throwTransportError(cause);
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
    throwTransportError(cause);
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

export function shouldRetryXMatrixQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (!(error instanceof XMatrixApiError)) return false;
  if (error.status === 0 || error.status === 408 || error.status === 429) return true;
  return error.status >= 500 && error.retryable;
}

/** Preserve the plain Error contract of raw-response command consumers. */
export async function requireResponseOk(response: Response, fallback: string, ignoredStatus?: number): Promise<void> {
  if (response.ok || response.status === ignoredStatus) return;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(payload.error || fallback);
}
