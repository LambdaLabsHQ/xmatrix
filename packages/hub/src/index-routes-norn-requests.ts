import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import { requireAgentRunChannelDelegation } from "./agent-run-channel-delegation";
import { jsonErrors, readBoundedRequestBody, requireAuth } from "./index-shared";
import { answerNornRequest, answerNornRequestAsPerson, askNornQuestion, openNornRequests } from "./norn-programs";
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
  // An Agent Run asks one question; the Hub writes its program and the Run's Instance is its author.
  app.post(HUB_ROUTES.norn_request_ask, c => jsonErrors(c, async () => {
    const run = (await requireAuth(c.req.raw, c.env)).agentRun;
    if (!run?.instanceId) return c.json({ error: "A question is asked by an Agent Run" }, 403, NO_STORE);
    await requireAgentRunChannelDelegation(c.env, run, []);
    const bytes = await readBoundedRequestBody(c.req.raw, 64 * 1024);
    let body: Record<string, unknown> | null = null;
    try { body = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null; } catch { /* refused below */ }
    const verb = (["ask", "confirm", "choose"] as const).find(value => value === body?.verb);
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
    const who = text(body?.who), question = text(body?.question);
    if (!verb || !who || !question) return c.json({ error: "Name whom to ask and what" }, 400, NO_STORE);
    const by = text(body?.by), otherwise = text(body?.otherwise);
    const asked = await askNornQuestion(c.env, { channelId: run.channelId, instanceId: run.instanceId, ownerUserId: run.ownerUserId,
      agentName: run.agentName }, { verb, who, question, ...(by ? { by } : {}), ...(otherwise ? { otherwise } : {}),
      ...(Array.isArray(body?.options) ? { options: body.options.filter((option): option is string => typeof option === "string") } : {}) });
    return c.json(asked, asked.refusal ? 400 : 200, NO_STORE);
  }));
  // A person answers the request on its card. Whoever they are, they hold it only if it was delivered to them.
  const personAnswer = HUB_ROUTES.channel_norn_request_answer(":channelId", ":requestRef")
    .replace("%3AchannelId", ":channelId").replace("%3ArequestRef", ":requestRef");
  app.post(personAnswer, c => jsonErrors(c, async () => {
    const auth = await requireAuth(c.req.raw, c.env);
    if (auth.agentRun) return c.json({ error: "A request of a person is answered by that person" }, 403, NO_STORE);
    const bytes = await readBoundedRequestBody(c.req.raw, 64 * 1024);
    let body: { outcome?: unknown; text?: unknown } | null = null;
    try { body = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null; } catch { /* refused below */ }
    const outcome = (["answered", "refused"] as const).find(value => value === body?.outcome);
    const requestRef = c.req.param("requestRef") ?? "", channelId = c.req.param("channelId") ?? "";
    if (!body || !/^r[a-z0-9]{6,40}$/u.test(requestRef) || !outcome || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "Give the answer, or the reason you decline" }, 400, NO_STORE);
    }
    const result = await answerNornRequestAsPerson(c.env, { channelId, userId: auth.id,
      requestRef, outcome, text: body.text.trim() });
    return result ? c.json(result, 200, NO_STORE) : c.json({ error: "This request is not open for you" }, 404, NO_STORE);
  }));
}
