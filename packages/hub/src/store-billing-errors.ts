import { readBoundedStream } from "@xmatrix/protocol";

/** A refusal from an app store's billing path; retryable ones are a passing outage. */
export class StoreBillingError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}

/** A store API's JSON answer, bounded; anything unreadable is a retryable store fault. */
export async function readStoreJson(response: Response, signal: AbortSignal, invalid: () => StoreBillingError): Promise<unknown> {
  try {
    const bytes = await readBoundedStream(response.body, 1_048_576, () => new Error("Store response is too large"), signal);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw invalid(); }
}
