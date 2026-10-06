import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "./types";
import { requireAuth, requireHumanAuth, requestErrorStatus } from "./index-shared";
import { ControlError } from "@xmatrix/db";
import { machineCommandStatus, machineDaemonCommand, machineRepository } from "./machines";
import { postgresControlErrorResponse } from "./postgres-authority-http";
import { runtimeRepository } from "./runtime";
import { safeReplyRecoveryResult } from "./reply-recovery-result";

export function registerReplyRecoveryRoutes(app: Hono<{ Bindings: Env }>): void {
  const path = "/api/channels/:channelId/executions/:bindingId/recover-reply";
  app.on(["GET", "POST"], path, bodyLimit({ maxSize: 4096 }), async c => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const channelId = c.req.param("channelId"), bindingId = c.req.param("bindingId");
      const write = c.req.method === "POST";
      const body = write ? await c.req.json().catch(() => null) : Object.fromEntries(new URL(c.req.url).searchParams);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["requestId", "messageId"].includes(key)) ||
          typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(body.requestId) ||
          body.messageId !== undefined && (typeof body.messageId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(body.messageId))) {
        return c.json({ error: "Recovery request is invalid" }, 400);
      }
      const target = await runtimeRepository(c.env).replyRecoveryTarget({ requestId: crypto.randomUUID(),
        channelId, bindingId, actorUserId: user.id, requireLive: write }) as Record<string, unknown>;
      const { runId, instanceId, agentId, executionId, executionKey } = target;
      const machineId = String(target.machineId ?? "");
      const hostId = typeof target.hostId === "string" ? target.hostId : "";
      const machines = machineRepository(c.env);
      const controlId = `reply-recovery:${body.requestId}`;
      const selection = { controlId, ownerUserId: user.id, runId, instanceId, agentId, executionId, executionKey,
        channelId, machineId, hostId, ...(body.messageId === undefined ? {} : { messageId: body.messageId }) };
      const readStatus = () => machineCommandStatus(machines, "recoverReply", selection);
      let status = await readStatus();
      if (write && status.status === "missing") {
        const route = await machines.getDaemon({ requestId: crypto.randomUUID(), ownerUserId: user.id, machineId, hostId });
        const daemon = route.daemon as { capabilities?: unknown; status?: string } | undefined;
        if (!daemon || daemon.status === "offline" || !Array.isArray(daemon.capabilities) || !daemon.capabilities.includes("reply_recovery_v1")) {
          return c.json({ error: "The original machine must be connected with reply recovery support", code: "reply_recovery_machine_unavailable" }, 409);
        }
        try {
          await machineDaemonCommand(c.env, {
            commandId: controlId, controlId, action: "issue", commandType: "recover_reply", ownerUserId: user.id, ownerEmail: user.email,
            machineId, hostId, metadata: {}, capabilities: [], principal: { kind: "user", id: user.id },
            payload: { type: "machine_recover_reply", requestId: controlId, runId, instanceId, executionId, executionKey, channelId,
              ...(body.messageId === undefined ? {} : { messageId: body.messageId }) },
          });
        } catch (error) {
          // A concurrent request issued the same recovery; its status says how it went.
          if (!(error instanceof ControlError) || error.status !== 409) throw error;
        }
        status = await readStatus();
      }
      const reported = status.result as { result?: unknown } | undefined;
      return c.json({ requestId: body.requestId, status: status.status,
        ...(reported ? { result: safeReplyRecoveryResult(reported.result) } : {}) }, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      if (error instanceof ControlError) return postgresControlErrorResponse(error);
      return c.json({ error: "Saved reply recovery could not be requested", code: "reply_recovery_failed" }, requestErrorStatus(error));
    }
  });
}
