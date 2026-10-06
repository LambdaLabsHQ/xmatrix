import { Hono } from "hono";
import {
  automationRef,
  HUB_ROUTES,
  sha256Hex,
  type AutomationActionType,
} from "@xmatrix/protocol";
import type { AgentRunPrincipal, AuthUser } from "./auth";
import type { Env } from "./types";
import {
  AUTOMATION_MAX_INTERVAL_MINUTES,
  AUTOMATION_MIN_INTERVAL_MINUTES,
  actorUserId,
  automationAgentContext,
  productCommandId,
  requireAuth,
  requireHumanAuth,
  requireLiveAgentRun,
  requestErrorResponse,
  automationEvalInput,
  automationExpression,
  automationIntervalMinutes,
  automationPayload,
} from "./index-shared";
import { commitAutomation, getAutomation, listAutomations } from "./automations";
import { publishAutomationSystemFact } from "./product-automation-system-fact";
import { automationEvaluatorBinding } from "./automation-evaluator-binding";
import * as pages from "./index-routes-page-automations";

/**
 * Everything these routes take from the Hub: authentication, the Automation
 * repository, system facts and the generic Automation helpers. Production passes nothing and gets the real
 * ones; tests pass their own boundary instead of rewriting module resolution.
 */
export interface AutomationRouteBoundary {
  AUTOMATION_MAX_INTERVAL_MINUTES: typeof AUTOMATION_MAX_INTERVAL_MINUTES;
  AUTOMATION_MIN_INTERVAL_MINUTES: typeof AUTOMATION_MIN_INTERVAL_MINUTES;
  actorUserId: typeof actorUserId;
  automationAgentContext: typeof automationAgentContext;
  productCommandId: typeof productCommandId;
  getAutomation: typeof getAutomation;
  listAutomations: typeof listAutomations;
  commitAutomation: typeof commitAutomation;
  requireAuth: typeof requireAuth;
  requireHumanAuth: typeof requireHumanAuth;
  requireLiveAgentRun: typeof requireLiveAgentRun;
  requestErrorResponse: typeof requestErrorResponse;
  automationEvalInput: typeof automationEvalInput;
  automationExpression: typeof automationExpression;
  automationIntervalMinutes: typeof automationIntervalMinutes;
  automationPayload: typeof automationPayload;
  sha256Hex: typeof sha256Hex;
  publishAutomationSystemFact: typeof publishAutomationSystemFact;
}

export const hubBoundary: AutomationRouteBoundary = {
  AUTOMATION_MAX_INTERVAL_MINUTES,
  AUTOMATION_MIN_INTERVAL_MINUTES,
  actorUserId,
  automationAgentContext,
  productCommandId,
  getAutomation,
  listAutomations,
  commitAutomation,
  requireAuth,
  requireHumanAuth,
  requireLiveAgentRun,
  requestErrorResponse,
  automationEvalInput,
  automationExpression,
  automationIntervalMinutes,
  automationPayload,
  sha256Hex,
  publishAutomationSystemFact,
};

const FORBIDDEN_AUTOMATION_FIELDS = new Set([
  "id", "version", "owner", "ownerUserId", "authorityRootUserId", "actor", "envRef", "input",
  "channelId", "lineage", "payloadVersion", "nextRunAt", "enabled", "capabilities", "canManage",
  "actionId", "expiresAt", "managementAudit", "automationAgent", "principal",
]);

export type AutomationRecord = Record<string, unknown> & {
  id: string;
  version: number;
  ownerUserId: string;
  authorityRootUserId: string;
  channelId: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string;
  capabilities: {
    update: boolean;
    pause: boolean;
    requestPause: false;
    resume: boolean;
    delete: boolean;
    reasonRequired: boolean;
  };
};

function principalInput(boundary: AutomationRouteBoundary, user: AuthUser, agent?: AgentRunPrincipal) {
  return agent
    ? { principal: { kind: "agent", id: agent.agentId }, automationAgent: boundary.automationAgentContext(agent) }
    : { principal: { kind: "user", id: user.id } };
}

function invalidAuthorityFields(body: Record<string, unknown>, allowChannel = false): string[] {
  return Object.keys(body).filter((field) => FORBIDDEN_AUTOMATION_FIELDS.has(field) && (field !== "channelId" || !allowChannel));
}

function unsupportedFields(body: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allow = new Set(allowed);
  return Object.keys(body).filter((field) => !allow.has(field));
}

function bodyFieldError(
  body: Record<string, unknown>,
  allowed: readonly string[],
  allowChannel = false,
): string | undefined {
  const allow = new Set(allowed);
  const invalid = invalidAuthorityFields(body, allowChannel).filter((field) => !allow.has(field));
  if (invalid.length) return `server-owned fields are not accepted: ${invalid.join(", ")}`;
  const unsupported = unsupportedFields(body, allowed);
  return unsupported.length ? `unsupported fields are not accepted: ${unsupported.join(", ")}` : undefined;
}

function expectedVersion(body: Record<string, unknown>): number | undefined {
  return Number.isSafeInteger(body.expectedVersion) && Number(body.expectedVersion) >= 1
    ? Number(body.expectedVersion) : undefined;
}

async function readAutomationRecord(
  boundary: AutomationRouteBoundary,
  env: Env,
  automationId: string,
  user: AuthUser,
  agent?: AgentRunPrincipal,
): Promise<AutomationRecord> {
  // PostgreSQL locates an Automation by its id, so no route lookup precedes the read.
  const result = await boundary.getAutomation(env, { automationId, ...principalInput(boundary, user, agent) });
  return result.task as AutomationRecord;
}

async function taskMutationContext(
  boundary: AutomationRouteBoundary,
  env: Env,
  request: Request,
  automationId: string,
): Promise<{
  user: AuthUser;
  agent?: AgentRunPrincipal;
  body: Record<string, unknown>;
  automation: AutomationRecord;
}> {
  const user = await boundary.requireAuth(request, env);
  const agent = user.agentRun ? await boundary.requireLiveAgentRun(env, user) : undefined;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  return { user, agent, body, automation: await readAutomationRecord(boundary, env, automationId, user, agent) };
}

export function expressionPayload(boundary: AutomationRouteBoundary, current: AutomationRecord | undefined, body: Record<string, unknown>): {
  payload: Record<string, unknown>;
  intervalMinutes: number;
  expression: Record<string, unknown>;
} | undefined {
  const stored = current?.payload && typeof current.payload === "object" && !Array.isArray(current.payload)
    ? current.payload as Record<string, unknown> : {};
  const payload = boundary.automationPayload(stored, body);
  const intervalMinutes = boundary.automationIntervalMinutes(payload);
  const expression = boundary.automationExpression(payload, automationRef(current?.id || "new"));
  return intervalMinutes !== undefined && expression ? { payload, intervalMinutes, expression } : undefined;
}

export function commandPayload(
  boundary: AutomationRouteBoundary,
  parsed: NonNullable<ReturnType<typeof expressionPayload>>,
  automation: AutomationRecord | undefined,
  channelId: string,
  actor: { kind: "user" | "agent"; id: string },
  authorityRootUserId: string,
  automationId: string,
): Record<string, unknown> {
  const currentInput = automation?.input && typeof automation.input === "object" && !Array.isArray(automation.input)
    ? automation.input as Record<string, unknown> : undefined;
  parsed.payload.payloadVersion = 3;
  parsed.payload.intervalMinutes = parsed.intervalMinutes;
  parsed.payload.input = boundary.automationEvalInput(
    parsed.expression,
    channelId,
    actor,
    authorityRootUserId,
    parsed.intervalMinutes,
    currentInput?.lineage ?? { rootMessageId: automationRef(automationId), depth: 0, budget: 128 },
  );
  delete parsed.payload.expression;
  delete parsed.payload.message;
  return parsed.payload;
}

async function managementAudit(
  boundary: AutomationRouteBoundary,
  request: Request,
  principal: AgentRunPrincipal,
  type: AutomationActionType,
  automation: AutomationRecord,
  reason: string,
  evidence: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || crypto.randomUUID();
  // The payloadHash preimage is frozen in its pre-rename spelling: the hash is
  // part of the command body a retry from before the rename was digested with.
  const payloadHash = await boundary.sha256Hex(JSON.stringify({
    type: type.replace("automation_", "scheduled_task_"), taskId: automation.id,
    taskVersion: automation.version, reason, evidence }));
  return {
    actionId: `automation-action:${await boundary.sha256Hex(`${principal.runId}:${idempotencyKey}`)}`.slice(0, 200),
    idempotencyKey,
    actionType: type,
    reason,
    evidence,
    payloadHash,
  };
}

async function mutateAutomation(boundary: AutomationRouteBoundary, input: {
  env: Env;
  request: Request;
  user: AuthUser;
  agent?: AgentRunPrincipal;
  automation: AutomationRecord;
  body: Record<string, unknown>;
  action: "update" | "pause" | "resume";
}): Promise<Response> {
  const capability = input.automation.capabilities[input.action];
  if (!capability) return Response.json({ error: `Automation ${input.action} is not permitted` }, { status: 403 });
  const version = expectedVersion(input.body);
  if (version === undefined || version !== input.automation.version) {
    return Response.json({ error: "expectedVersion must match the current Automation version" }, { status: 409 });
  }
  const parsed = expressionPayload(boundary, input.automation, input.action === "update" ? input.body : {});
  if (!parsed) return Response.json({
    error: `expression.text is required and intervalMinutes must be between ${boundary.AUTOMATION_MIN_INTERVAL_MINUTES} and ${boundary.AUTOMATION_MAX_INTERVAL_MINUTES}`,
  }, { status: 400 });
  const evaluatorBinding = automationEvaluatorBinding(input.automation);
  if (!evaluatorBinding) {
    return Response.json({ error: "Automation evaluator authority is unavailable" }, { status: 409 });
  }
  if (!input.agent && input.action === "update" &&
      evaluatorBinding.authorityRootUserId !== input.user.id) {
    return replaceAutomation(boundary, { ...input, parsed, expectedVersion: version });
  }
  const payload = commandPayload(boundary,
    parsed, input.automation, input.automation.channelId, evaluatorBinding.actor,
    evaluatorBinding.authorityRootUserId,
    input.automation.id,
  );
  const intervalMinutes = parsed.intervalMinutes;
  const nextEnabled = input.action === "pause" ? false : input.action === "resume" ? true : input.automation.enabled;
  // Retiming restarts the clock: a shortened cadence must not wait out the old
  // interval, and a lengthened one must not keep a run that was already due.
  const nextRunAt = input.action === "resume"
    ? new Date(Date.now() + intervalMinutes * 60_000).toISOString()
    : input.automation.nextRunAt;
  let audit: Record<string, unknown> | undefined;
  const reason = typeof input.body.reason === "string" ? input.body.reason.trim() : "";
  if (input.agent && input.automation.capabilities.reasonRequired) {
    if (!reason) return Response.json({ error: "reason is required for Agent schedule governance" }, { status: 400 });
    audit = await managementAudit(boundary, input.request, input.agent,
      `automation_${input.action}`,
      input.automation, reason, input.body.evidence && typeof input.body.evidence === "object" ? input.body.evidence as Record<string, unknown> : {});
  }
  await boundary.commitAutomation(input.env, {
    commandId: boundary.productCommandId(input.request, "domain", audit ? `automation:${audit.idempotencyKey}` : undefined),
    actorUserId: boundary.actorUserId(input.user), at: new Date().toISOString(), kind: "automation_put",
    automationId: input.automation.id, expectedVersion: version, channelId: input.automation.channelId,
    nextRunAt, enabled: nextEnabled, payload, automationAction: input.action,
    ...principalInput(boundary, input.user, input.agent), ...(audit ? { managementAudit: audit } : {}),
  });
  const updated = await readAutomationRecord(boundary, input.env, input.automation.id, input.user, input.agent);
  if (audit) {
    const messageFailure = await boundary.publishAutomationSystemFact({
      env: input.env, ownerUserId: input.automation.authorityRootUserId,
      channelId: input.automation.channelId, actionId: String(audit.actionId), phase: "result",
      body: `xMatrix Agent ${input.action}d Automation “${String(input.automation.name || input.automation.id)}”. Reason: ${reason}`,
      metadata: { automationId: input.automation.id, automationVersion: updated.version, action: input.action },
    });
    if (messageFailure) return messageFailure;
  }
  return Response.json({ automation: updated });
}

/**
 * An evaluation runs as its author, so a Human rewriting someone else's
 * evaluation creates their own in its place. The Channel authority swaps them
 * in one transaction; the directory then follows the new Automation.
 */
async function replaceAutomation(boundary: AutomationRouteBoundary, input: {
  env: Env;
  request: Request;
  user: AuthUser;
  automation: AutomationRecord;
  parsed: NonNullable<ReturnType<typeof expressionPayload>>;
  expectedVersion: number;
}): Promise<Response> {
  const automationId = crypto.randomUUID();
  const actor = { kind: "user" as const, id: input.user.id };
  const payload = commandPayload(boundary, input.parsed, undefined, input.automation.channelId,
    actor, input.user.id, automationId);
  await boundary.commitAutomation(input.env, {
    commandId: boundary.productCommandId(input.request, "domain"),
    actorUserId: input.user.id, at: new Date().toISOString(), kind: "automation_put",
    automationId, expectedVersion: 0, channelId: input.automation.channelId,
    nextRunAt: input.automation.nextRunAt, enabled: input.automation.enabled, payload,
    automationAction: "update",
    replacesAutomation: { automationId: input.automation.id, expectedVersion: input.expectedVersion },
    principal: { kind: "user", id: input.user.id },
  });
  const created = await readAutomationRecord(boundary, input.env, automationId, input.user);
  return Response.json({ automation: created, replacedAutomationId: input.automation.id });
}

/**
 * A page's Automation is changed through its page (docs/design/pages-live-document.md §6),
 * which also keeps the page's reference to it right; the Space-wide routes hand it over.
 */
async function throughPage(context: { user: AuthUser; automation: AutomationRecord; body: Record<string, unknown> },
  request: Request, env: Env, action: "update" | "pause" | "resume" | "delete"): Promise<Response | undefined> {
  const { automation } = context;
  if (typeof automation.pageId !== "string" || typeof automation.spaceId !== "string") return undefined;
  try {
    if (action === "delete") {
      await pages.deletePageAutomation(env, request, context.user, automation.spaceId, automation.pageId,
        automation.id, context.body);
      return Response.json({ ok: true, automationId: automation.id });
    }
    return Response.json({ automation: await pages.changePageAutomation(env, request, context.user,
      automation.spaceId, automation.pageId, automation.id, action, context.body) });
  } catch (error) {
    return pages.pageAutomationFailure(error);
  }
}

export function registerIndexRoutesAutomation(
  app: Hono<{ Bindings: Env }>,
  boundary: AutomationRouteBoundary = hubBoundary,
): void {
  app.get(HUB_ROUTES.automations, async (c) => {
    try {
      const user = await boundary.requireAuth(c.req.raw, c.env);
      const agent = user.agentRun ? await boundary.requireLiveAgentRun(c.env, user) : undefined;
      const requestedChannelId = c.req.query("channelId")?.trim();
      const requestedSpaceId = c.req.query("spaceId")?.trim();
      if (agent && !agent.managementSpaceId && requestedChannelId && requestedChannelId !== agent.channelId) {
        return c.json({ error: "Agent Automation reads require the birth channelId" }, 403);
      }
      if (agent?.managementSpaceId && requestedSpaceId && requestedSpaceId !== agent.managementSpaceId) {
        return c.json({ error: "Management Agent Automation reads require its management Space" }, 403);
      }
      const channelId = agent && !agent.managementSpaceId && !requestedSpaceId
        ? agent.channelId : requestedChannelId;
      const spaceId = agent?.managementSpaceId || requestedSpaceId;
      const { automations, executionEnabled } = await boundary.listAutomations(c.env, {
        ...(channelId ? { channelId } : {}), ...(spaceId ? { spaceId } : {}), ...principalInput(boundary, user, agent) });
      return c.json({ automations, executionEnabled, agentManagementEnabled: true });
    } catch (error) {
      return boundary.requestErrorResponse(c, error);
    }
  });

  // An Automation belongs to the page section it keeps true
  // (docs/design/pages-live-document.md §6).
  app.post(HUB_ROUTES.automations, (c) => c.json({
    error: "An Automation lives on a page: create it in a page section with " +
      "POST /api/spaces/:spaceId/pages/:pageId/automations or `xmatrix page automation create`",
    code: "automation_lives_on_a_page",
  }, 410));

  app.get("/api/automations/:automationId", async (c) => {
    try {
      const user = await boundary.requireAuth(c.req.raw, c.env);
      const agent = user.agentRun ? await boundary.requireLiveAgentRun(c.env, user) : undefined;
      return c.json({ automation: await readAutomationRecord(boundary, c.env, c.req.param("automationId") || "", user, agent) });
    } catch (error) {
      return boundary.requestErrorResponse(c, error);
    }
  });

  app.patch("/api/automations/:automationId", async (c) => {
    try {
      const context = await taskMutationContext(boundary, c.env, c.req.raw, c.req.param("automationId") || "");
      const bodyError = bodyFieldError(context.body,
        ["expectedVersion", "name", "expression", "message", "intervalMinutes", "reason", "evidence"]);
      if (bodyError) return c.json({ error: bodyError }, 400);
      const paged = await throughPage(context, c.req.raw, c.env, "update");
      if (paged) return paged;
      return mutateAutomation(boundary, {
        env: c.env, request: c.req.raw, user: context.user, agent: context.agent,
        automation: context.automation, body: context.body, action: "update",
      });
    } catch (error) {
      return boundary.requestErrorResponse(c, error);
    }
  });

  for (const action of ["pause", "resume"] as const) {
    app.post(action === "pause" ? "/api/automations/:automationId/pause" : "/api/automations/:automationId/resume", async (c) => {
      try {
        const context = await taskMutationContext(boundary, c.env, c.req.raw, c.req.param("automationId") || "");
          const bodyError = bodyFieldError(context.body, ["expectedVersion", "reason", "evidence"]);
        if (bodyError) return c.json({ error: bodyError }, 400);
        const paged = await throughPage(context, c.req.raw, c.env, action);
        if (paged) return paged;
        return mutateAutomation(boundary, {
          env: c.env, request: c.req.raw, user: context.user, agent: context.agent,
          automation: context.automation, body: context.body, action,
        });
      } catch (error) {
        return boundary.requestErrorResponse(c, error);
      }
    });
  }

  app.post("/api/automations/:automationId/cancel-execution", async (c) => {
    try {
      const user = boundary.requireHumanAuth(await boundary.requireAuth(c.req.raw, c.env));
      const body = await c.req.json() as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Invalid body" }, 400);
      const issue = bodyFieldError(body, ["runId"]);
      if (issue) return c.json({ error: issue }, 400);
      if (typeof body.runId !== "string" || !body.runId.trim()) return c.json({ error: "runId is required" }, 400);
      const current = await readAutomationRecord(boundary, c.env, c.req.param("automationId"), user);
      if (current.ownerUserId !== user.id) return c.json({ error: "Only the Automation owner may cancel its execution" }, 403);
      const result = await boundary.commitAutomation(c.env, {
        commandId: boundary.productCommandId(c.req.raw, "domain"),
        actorUserId: user.id, at: new Date().toISOString(), kind: "scheduled_execution_cancel",
        automationId: current.id, channelId: current.channelId, runId: body.runId.trim(),
        principal: { kind: "user", id: user.id },
      });
      return Response.json(result, { headers: { "cache-control": "private, no-store" } });
    } catch (error) {
      return boundary.requestErrorResponse(c, error);
    }
  });

  app.delete("/api/automations/:automationId", async (c) => {
    try {
      const context = await taskMutationContext(boundary, c.env, c.req.raw, c.req.param("automationId") || "");
      const { body, automation, agent, user } = context;
      const bodyError = bodyFieldError(body, ["expectedVersion", "reason", "evidence"]);
      if (bodyError) return c.json({ error: bodyError }, 400);
      const paged = await throughPage(context, c.req.raw, c.env, "delete");
      if (paged) return paged;
      const version = expectedVersion(body);
      if (!automation.capabilities.delete) return c.json({ error: "Automation delete is not permitted" }, 403);
      if (version !== automation.version) return c.json({ error: "expectedVersion must match the current Automation version" }, 409);
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      let audit: Record<string, unknown> | undefined;
      if (agent && automation.capabilities.reasonRequired) {
        if (!reason) return c.json({ error: "reason is required for Management Agent governance" }, 400);
        audit = await managementAudit(boundary, c.req.raw, agent, "automation_delete", automation, reason,
          body.evidence && typeof body.evidence === "object" && !Array.isArray(body.evidence)
            ? body.evidence as Record<string, unknown> : {});
      }
      await boundary.commitAutomation(c.env, {
        commandId: boundary.productCommandId(c.req.raw, "domain", audit ? `automation:${audit.idempotencyKey}` : undefined),
        actorUserId: boundary.actorUserId(user), at: new Date().toISOString(), kind: "automation_remove",
        automationId: automation.id, expectedVersion: version, ...principalInput(boundary, user, agent),
        ...(audit ? { managementAudit: audit } : {}),
      });
      if (audit) {
        const failure = await boundary.publishAutomationSystemFact({
          env: c.env, ownerUserId: automation.authorityRootUserId,
          channelId: automation.channelId, actionId: String(audit.actionId), phase: "result",
          body: `xMatrix management deleted Automation lineage “${String(automation.name || automation.id)}”. Reason: ${reason}`,
          metadata: { automationId: automation.id, automationVersion: version, action: "delete" },
        });
        if (failure) return failure;
      }
      return c.json({ ok: true, automationId: automation.id });
    } catch (error) {
      return boundary.requestErrorResponse(c, error);
    }
  });

}
