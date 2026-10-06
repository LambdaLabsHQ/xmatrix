import { requestErrorStatus } from "./index-shared";
import { privateResponse } from "./private-response";
import { ControlError } from "@xmatrix/db";
import { postgresControlErrorResponse } from "./postgres-authority-http";

/** Keep an authenticated route's response uncached, including its admission failures. */
export async function privateRouteResponse(operation: () => Promise<Response>): Promise<Response> {
  try {
    return privateResponse(await operation());
  } catch (error) {
    if (error instanceof ControlError) return postgresControlErrorResponse(error);
    return Response.json({ error: error instanceof Error ? error.message : "Request failed" }, {
      status: requestErrorStatus(error), headers: { "cache-control": "private, no-store" },
    });
  }
}
