import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import { requireAgentRunChannelDelegation } from "./agent-run-channel-delegation";
import { jsonErrors, readBoundedRequestBody, requireAuth } from "./index-shared";
import { messageProgramStatus, nornRequestsOfPerson, nornRequestView } from "./norn-page-programs";
import { answerNornRequest, answerNornRequestAsPerson, askNornQuestion, callOffNornQuestion, delegateNornRequest, openNornRequests,
  reclaimNornRequest } from "./norn-programs";
import type { Env } from "./types";

const NO_STORE = { "cache-control": "private, no-store" };
const OUTCOMES = ["answered", "refused", "broke"] as const;
const REQUEST_REF = /^r[a-z0-9]{6,40}$/u;

/** A JSON object body of at most 64 KiB; null when there is none. */
async function objectBody(request: Request): Promise<Record<string, unknown> | null> {
  const bytes = await readBoundedRequestBody(request, 64 * 1024);
  try {
    const value: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
/** Whom a holder delegates a request to, and why in their words, as a body gives them. */
function delegation(body: Record<string, unknown> | null): { to: string; reason?: string } | undefined {
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  return to ? { to, ...(reason ? { reason: reason.slice(0, 2000) } : {}) } : undefined;
}

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
      ownerUserId: run.ownerUserId, requestRef: body.requestRef, outcome, text: body.text.trim(),
      agent: { agentId: run.agentId, agentName: run.agentName || run.agentId, executionKey: run.executionKey } }), 200, NO_STORE);
  }));
  // The Run that holds a request delegates it to someone who answers it for them; the repository checks it holds it.
  app.post(HUB_ROUTES.norn_request_delegate, c => jsonErrors(c, async () => {
    const run = (await requireAuth(c.req.raw, c.env)).agentRun;
    if (!run?.instanceId) return c.json({ error: "A request is delegated by the Agent Run that holds it" }, 403, NO_STORE);
    await requireAgentRunChannelDelegation(c.env, run, []);
    const body = await objectBody(c.req.raw), to = delegation(body);
    if (typeof body?.requestRef !== "string" || !REQUEST_REF.test(body.requestRef) || !to) {
      return c.json({ error: "Name the request and whom to delegate it to" }, 400, NO_STORE);
    }
    const result = await delegateNornRequest(c.env, { channelId: run.channelId, requestRef: body.requestRef, ...to,
      delegator: { kind: "run", runId: run.runId, instanceId: run.instanceId, ownerUserId: run.ownerUserId } });
    return result ? c.json(result, result.refusal ? 400 : 200, NO_STORE) : c.json({ error: "No such request" }, 404, NO_STORE);
  }));
  // The Run whose Instance asked a question with a command calls it off; the repository checks it asked it.
  app.post(HUB_ROUTES.norn_request_call_off, c => jsonErrors(c, async () => {
    const run = (await requireAuth(c.req.raw, c.env)).agentRun;
    if (!run?.instanceId) return c.json({ error: "A question is called off by the Agent Run that asked it" }, 403, NO_STORE);
    await requireAgentRunChannelDelegation(c.env, run, []);
    const body = await objectBody(c.req.raw);
    if (typeof body?.requestRef !== "string" || !REQUEST_REF.test(body.requestRef)) return c.json({ error: "Name the question's request" }, 400, NO_STORE);
    const result = await callOffNornQuestion(c.env, { channelId: run.channelId, requestRef: body.requestRef, instanceId: run.instanceId });
    return result ? c.json(result, 200, NO_STORE) : c.json({ error: "You asked no such open question here" }, 404, NO_STORE);
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
  // What waits on the caller in a Space: every open request they hold, as its card shows it.
  app.get(HUB_ROUTES.space_norn_requests(":spaceId").replace("%3AspaceId", ":spaceId"), c => jsonErrors(c, async () => {
    const auth = await requireAuth(c.req.raw, c.env);
    if (auth.agentRun) return c.json({ error: "What waits on a person is listed for that person" }, 403, NO_STORE);
    return c.json({ requests: await nornRequestsOfPerson(c.env, { spaceId: c.req.param("spaceId") ?? "", userId: auth.id }) },
      200, NO_STORE);
  }));
  // What a request reference shows in its place, for a person who can read the request's conversation.
  const view = HUB_ROUTES.space_norn_request(":spaceId", ":requestRef").replace("%3AspaceId", ":spaceId").replace("%3ArequestRef", ":requestRef");
  app.get(view, c => jsonErrors(c, async () => {
    const auth = await requireAuth(c.req.raw, c.env);
    const requestRef = c.req.param("requestRef") ?? "";
    if (auth.agentRun || !/^r[a-z0-9]{6,40}$/u.test(requestRef)) return c.json({ error: "No such request" }, 404, NO_STORE);
    const request = await nornRequestView(c.env, { spaceId: c.req.param("spaceId") ?? "", requestRef, userId: auth.id });
    return request ? c.json({ request }, 200, NO_STORE) : c.json({ error: "No such request" }, 404, NO_STORE);
  }));
  // How the program a message carries stands and what it does next, for a person who can read its conversation.
  const program = HUB_ROUTES.space_norn_program(":spaceId", ":programId").replace("%3AspaceId", ":spaceId").replace("%3AprogramId", ":programId");
  app.get(program, c => jsonErrors(c, async () => {
    const auth = await requireAuth(c.req.raw, c.env);
    const programId = c.req.param("programId") ?? "";
    if (auth.agentRun) return c.json({ error: "A program's flow is drawn for a person" }, 403, NO_STORE);
    // A message that only shows Norn text is no program: that is an answer, not a failure.
    const found = !programId || programId.length > 200 ? undefined
      : await messageProgramStatus(c.env, { spaceId: c.req.param("spaceId") ?? "", programId, userId: auth.id });
    return c.json({ program: found ?? null }, 200, NO_STORE);
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
  // The person who holds a request delegates it from its card; the one who delegated it takes it back. Each is found
  // by their id on the request's index row, never by a name.
  for (const [route, act] of [[HUB_ROUTES.channel_norn_request_delegate, "delegate"], [HUB_ROUTES.channel_norn_request_reclaim, "reclaim"]] as const) {
    const path = route(":channelId", ":requestRef").replace("%3AchannelId", ":channelId").replace("%3ArequestRef", ":requestRef");
    app.post(path, c => jsonErrors(c, async () => {
      const auth = await requireAuth(c.req.raw, c.env);
      if (auth.agentRun) return c.json({ error: "A person's request is delegated and taken back by that person" }, 403, NO_STORE);
      const requestRef = c.req.param("requestRef") ?? "", channelId = c.req.param("channelId") ?? "";
      const to = act === "delegate" ? delegation(await objectBody(c.req.raw)) : undefined;
      if (!REQUEST_REF.test(requestRef) || (act === "delegate" && !to)) return c.json({ error: "Name whom to delegate the request to" }, 400, NO_STORE);
      const result = to ? await delegateNornRequest(c.env, { channelId, requestRef, ...to, delegator: { kind: "person", userId: auth.id } })
        : await reclaimNornRequest(c.env, { channelId, requestRef, userId: auth.id });
      if (!result) return c.json({ error: act === "delegate" ? "This request is not open for you" : "You have no such request to take back" }, 404, NO_STORE);
      return c.json(result, result.refusal ? 400 : 200, NO_STORE);
    }));
  }
}
