import type { Hono } from "hono";
import { crossSpaceRetryOwner } from "./cross-space-read";
import { ControlError, PostgresContentRepository } from "@xmatrix/db";
import { postgresControlErrorResponse } from "./postgres-authority-http";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { requireAuth, requestErrorStatus } from "./index-shared";
import type { Env } from "./types";
import { sha256Hex } from "@xmatrix/protocol";

export function registerSummonDecisionRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/channels/:channelId/messages/:messageId/decision-evidence", async c => {
    try {
      const user = await requireAuth(c.req.raw, c.env);
      const shardId = c.env.RELAY_POSTGRES_SHARD_ID;
      if (!shardId || !c.env.RELAY_PAYLOAD_BUCKET) return c.json({ error: "Decision evidence storage is unavailable" }, 503);
      const content = new PostgresContentRepository(createPostgresAuthorityDatabase(c.env, {
        applicationName: "xmatrix-summon-evidence-read", statementTimeoutMs: 5_000,
        transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
      }), shardId);
      const refId = c.req.query("refId");
      const channelId = c.req.param("channelId");
      const read = (principal: { kind: "user" | "agent"; id: string }) => content.summonDecisionRefs({
        requestId: crypto.randomUUID(), channelId, sourceMessageId: c.req.param("messageId"), principal,
        ...(principal.kind === "agent" && user.agentRun ? { runProof: { runId: user.agentRun.runId,
          instanceId: user.agentRun.instanceId ?? "", executionKey: user.agentRun.executionKey } } : {}),
        ...(refId ? { refId } : {}),
        ...(c.req.query("after") ? { afterRefId: c.req.query("after") } : {}),
      });
      let result: Awaited<ReturnType<typeof read>>;
      try {
        result = await read(user.agentRun ? { kind: "agent", id: user.agentRun.agentId } : { kind: "user", id: user.id });
      } catch (error) {
        // Outside its own Space an Agent reads only through its owner's grant, as its owner.
        const denied = decisionFailure(error);
        if (!user.agentRun || !denied) throw error;
        const granted = await crossSpaceRetryOwner(c.env, user.agentRun, { channelId }, denied);
        if (granted instanceof Response) return granted;
        result = await read(granted.owner);
      }
      if (!refId) return c.json({ records: result.refs.map(ref => ({ refId: ref.refId, createdAt: ref.createdAt,
        encodedBytes: ref.encodedBytes })), nextCursor: result.nextCursor, retentionDays: 30 }, 200,
        { "cache-control": "private, no-store" });
      const ref = result.refs[0];
      if (!ref || ref.refId !== refId) return c.json({ error: "Decision record is unavailable" }, 404);
      if (!Number.isSafeInteger(ref.encodedBytes) || Number(ref.encodedBytes) > 128 * 1024) {
        return c.json({ error: "Decision record is invalid" }, 502);
      }
      const object = await c.env.RELAY_PAYLOAD_BUCKET.get(String(ref.objectKey));
      if (!object || object.size !== ref.encodedBytes) return c.json({ error: "Decision payload is unavailable" }, 503);
      const bytes = await object.arrayBuffer();
      const checksum = await sha256Hex(new Uint8Array(bytes));
      if (checksum !== ref.checksum) return c.json({ error: "Decision payload verification failed" }, 502);
      return new Response(bytes, { headers: { "content-type": "application/json", "cache-control": "private, no-store",
        "content-disposition": 'attachment; filename="summon-decision.json"', "x-content-type-options": "nosniff" } });
    } catch (error) {
      return decisionFailure(error) ??
        c.json({ error: "Decision evidence request failed" }, requestErrorStatus(error), { "cache-control": "private, no-store" });
    }
  });
}

function decisionFailure(error: unknown): Response | null {
  return error instanceof ControlError ? postgresControlErrorResponse(error) : null;
}
