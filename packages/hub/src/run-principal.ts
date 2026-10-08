import { MessageAuthorityError, type AgentChannelRunProof } from "@xmatrix/db";
import type { Context } from "hono";
import type { AuthUser } from "./auth";
import { domainFailure, failureResponse } from "./error-contract";
import { requireAuth, requestErrorResponse } from "./index-shared";
import type { Env } from "./types";

export type RunPrincipal =
  | { kind: "user"; id: string; label?: string }
  | { kind: "agent"; id: string; label?: string; runProof: AgentChannelRunProof };

/**
 * The principal a repository authorizes: a human as themselves, or an Agent
 * Run by its exact Run proof, never by its display name.
 */
export function runPrincipalOf(authUser: AuthUser): RunPrincipal {
  const run = authUser.agentRun;
  if (!run) return { kind: "user", id: authUser.id, label: authUser.name || authUser.email };
  return { kind: "agent", id: run.agentId, label: run.agentName, runProof: {
    runId: run.runId, instanceId: run.instanceId ?? "", executionKey: run.executionKey,
  } };
}

export async function requestPrincipal(c: Context<{ Bindings: Env }>): Promise<RunPrincipal> {
  return runPrincipalOf(await requireAuth(c.req.raw, c.env));
}

/** A repository's typed refusal as JSON with its status; anything else by request status. */
export function authorityFailure(c: Context<{ Bindings: Env }>, error: unknown,
  detail?: Record<string, unknown>): Response {
  if (error instanceof MessageAuthorityError) return failureResponse(domainFailure(error, detail ? { detail } : {}));
  return requestErrorResponse(c, error);
}
