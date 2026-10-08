import { requestFailure } from "./index-shared";
import { privateResponse } from "./private-response";
import { failureResponse } from "./error-contract";

/** Keep an authenticated route's response uncached, including its admission failures. */
export async function privateRouteResponse(operation: () => Promise<Response>): Promise<Response> {
  try {
    return privateResponse(await operation());
  } catch (error) {
    return failureResponse(requestFailure(error), { "cache-control": "private, no-store" });
  }
}
