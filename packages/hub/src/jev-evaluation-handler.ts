import { createJevClient, MAX_INPUT_BYTES, type JevInput } from "@xmatrix/decision-model";
import { admitRequest, rateLimitedResponse } from "./request-rate-limit";
import type { Env } from "./types";
import { meterJev, type UsageCostEnv } from "./usage-cost-metering";

type JevEnv = Pick<Env, "JEV_AI_GATEWAY_API_KEY" | "RATE_LIMIT_JEV_EVALUATE"> & UsageCostEnv;
const headers = { "cache-control": "private, no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Authorization is resolved by the existing Hub boundary, before parsing input.
 * Every account may evaluate, so each owner's evaluations are bounded instead:
 * an Agent Run spends its owner's allowance.
 */
export async function evaluateJevRequest(
  request: Request,
  env: JevEnv,
  authorize: () => Promise<string>,
  readBody: (request: Request, limit: number) => Promise<ArrayBuffer | null>,
): Promise<Response> {
  const userId = await authorize();
  if (!userId) return failure("jev_access_denied", 403);
  if (!await admitRequest(env, "jev_evaluate", userId)) return rateLimitedResponse();
  if (!env.JEV_AI_GATEWAY_API_KEY?.trim()) {
    return failure("jev_not_configured", 503);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return failure("jev_json_required", 415);
  }
  const body = await readBody(request, MAX_INPUT_BYTES);
  if (body === null) return failure("jev_input_too_large", 413);
  let input: JevInput;
  try {
    input = JSON.parse(new TextDecoder().decode(body));
    if (!input || typeof input !== "object" || Array.isArray(input)
      || !Object.hasOwn(input, "state") || !Object.hasOwn(input, "questions")
      || Object.keys(input).some((key) => key !== "state" && key !== "questions")) {
      return failure("jev_invalid_input", 400);
    }
  } catch { return failure("jev_invalid_input", 400); }
  try {
    // An evaluation has no Space: its cost is the calling owner's.
    const result = await meterJev(env, { feature: "evaluate", scope: { ownerUserId: userId } },
      createJevClient({ apiKey: env.JEV_AI_GATEWAY_API_KEY }).evaluate)(input);
    return Response.json(result, { headers });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "jev_invalid_input") return failure(code, 400);
    if (code === "jev_rate_limited") return failure(code, 429);
    if (code === "jev_aborted") return failure(code, 504);
    return failure("jev_evaluation_failed", 502);
  }
}
