import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import { requireAgentRunChannelDelegation } from "./agent-run-channel-delegation";
import { jsonErrors, readBoundedRequestBody, requireAuth } from "./index-shared";
import { answerNornRequest, openNornRequests } from "./norn-programs";
import type { Env } from "./types";

const NO_STORE = { "cache-control": "private, no-store" };
const OUTCOMES = ["answered", "refused", "broke"] as const;

/**
 * An Agent Run reads and answers the Norn requests of its own Channel. Only
 * the Run a request was delivered to holds it; the repository checks that
 * against the delivery, never against a name the caller gives.
 */
export function registerNornRequestRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get(HUB_ROUTES.norn_requests, c => jsonErrors(c, async () => {
    const run = (await requireAuth(c.req.raw, c.env)).agentRun;
    if (!run?.instanceId) return c.json({ error: "Requests are read by an Agent Run" }, 403, NO_STORE);
    await requireAgentRunChannelDelegation(c.env, run, []);
    return c.json({ requests: await openNornRequests(c.env, { channelId: run.channelId, runId: run.runId,
      instanceId: run.instanceId }) }, 200, NO_STORE);
  }));
  app.post(HUB_ROUTES.norn_request_answer, c => jsonErrors(c, async () => {
    const run = (await requireAuth(c.req.raw, c.env)).agentRun;
    if (!run?.instanceId) return c.json({ error: "A request is answered by the Agent Run that holds it" }, 403, NO_STORE);
    await requireAgentRunChannelDelegation(c.env, run, []);
    const bytes = await readBoundedRequestBody(c.req.raw, 64 * 1024);
    let body: { requestRef?: unknown; outcome?: unknown; text?: unknown } | null = null;
    try { body = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null; } catch { /* refused below */ }
    const outcome = OUTCOMES.find(value => value === body?.outcome);
    if (!body || typeof body.requestRef !== "string" || !/^r[a-z0-9]{6,40}$/u.test(body.requestRef) || !outcome ||
        typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "Name the request and give its answer or the reason" }, 400, NO_STORE);
    }
    return c.json(await answerNornRequest(c.env, { channelId: run.channelId, runId: run.runId, instanceId: run.instanceId,
      requestRef: body.requestRef, outcome, text: body.text.trim() }), 200, NO_STORE);
  }));
}
