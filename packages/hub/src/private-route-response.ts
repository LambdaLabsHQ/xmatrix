import type { Context } from "hono";
import { requestFailure, routeReportContext } from "./index-shared";
import { privateResponse } from "./private-response";
import { failureResponse } from "./error-contract";

/** Keep an authenticated route's response uncached, including its admission failures. */
export async function privateRouteResponse(c: Context, operation: () => Promise<Response>): Promise<Response> {
  try {
    return privateResponse(await operation());
  } catch (error) {
    return failureResponse(requestFailure(error, () => routeReportContext(c)), { "cache-control": "private, no-store" });
  }
}
