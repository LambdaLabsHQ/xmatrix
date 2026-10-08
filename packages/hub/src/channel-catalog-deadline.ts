import { domainFailure, failureResponse, ServiceUnavailable } from "./error-contract";

export const CHANNEL_CATALOG_TOTAL_TIMEOUT_MS = 12_000;
export const CHANNEL_CATALOG_OPERATION_TIMEOUT_MS = 4_000;
export const CHANNEL_CATALOG_RETRY_AFTER_SECONDS = 2;

export type ChannelCatalogTimeoutBoundary =
  | "none"
  | "directory"
  | "authority_page"
  | "revision_probe"
  | "projection"
  | "runtime_presence";

/** A catalog operation that outlived its deadline at `boundary`; a replay after a short wait can succeed. */
export class ChannelCatalogTimeoutError extends ServiceUnavailable {
  constructor(readonly boundary: Exclude<ChannelCatalogTimeoutBoundary, "none">) {
    super("channel_catalog_timeout", "Channel catalog is temporarily unavailable",
      CHANNEL_CATALOG_RETRY_AFTER_SECONDS * 1_000);
    this.name = "ChannelCatalogTimeoutError";
  }
}

/**
 * One absolute request budget plus a shorter per-operation ceiling. The
 * absolute deadline prevents a large paged/fan-out catalog from multiplying
 * the per-operation timeout by its number of pages or Spaces.
 */
export function createChannelCatalogDeadline(input: {
  totalTimeoutMs?: number;
  operationTimeoutMs?: number;
  now?: () => number;
  onTimeout?: (boundary: Exclude<ChannelCatalogTimeoutBoundary, "none">) => void;
} = {}) {
  const now = input.now ?? Date.now;
  const deadlineAtMs = now() + (input.totalTimeoutMs ?? CHANNEL_CATALOG_TOTAL_TIMEOUT_MS);
  const operationTimeoutMs = input.operationTimeoutMs ?? CHANNEL_CATALOG_OPERATION_TIMEOUT_MS;

  return {
    async wait<T>(
      boundary: Exclude<ChannelCatalogTimeoutBoundary, "none">,
      operation: Promise<T>,
    ): Promise<T> {
      const remainingMs = deadlineAtMs - now();
      if (remainingMs <= 0) {
        input.onTimeout?.(boundary);
        throw new ChannelCatalogTimeoutError(boundary);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          input.onTimeout?.(boundary);
          reject(new ChannelCatalogTimeoutError(boundary));
        }, Math.min(operationTimeoutMs, remainingMs));
      });
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

export type ChannelCatalogDeadline = ReturnType<typeof createChannelCatalogDeadline>;

export function isChannelCatalogTimeoutError(error: unknown): error is ChannelCatalogTimeoutError {
  return error instanceof ChannelCatalogTimeoutError;
}

export function channelCatalogTimeoutResponse(error: ChannelCatalogTimeoutError): Response {
  return failureResponse(domainFailure(error, { boundary: error.boundary }));
}
