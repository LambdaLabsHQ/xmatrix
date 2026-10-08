import type { Hono } from "hono";
import { createJevClient } from "@xmatrix/decision-model";
import { PostgresChannelSpaceDirectory, RegistrationAccessError } from "@xmatrix/db";
import type { SummonIntentCategory } from "@xmatrix/protocol";

import type { Env } from "./types";
import { actorUserId, jsonErrors, requireAuth, requireHumanAuth } from "./index-shared";
import { evaluateRoutingChoices, type RoutingEvaluator } from "./agent-routing-evaluation";
import { registrationLaunchContextReader } from "./registration-launch-context";
import { SUMMON_INTENT_QUESTION } from "./registration-launch-choice";
import { runtimePlacement } from "./runtime";

const NO_STORE = { "cache-control": "private, no-store" };
const MAX_DRAFT = 20_000;
const MAX_SUMMONS = 4;

/** Jev's reading of each summon in a draft over the Channel as it is now: the
 * question the Hub would otherwise ask after the message is sent. */
export async function readDraftSummonIntents(input: {
  evaluate: RoutingEvaluator; body: string; channelContext: Record<string, unknown>;
  summons: ReadonlyArray<{ start: number; end: number }>;
}): Promise<Array<{ start: number; end: number; mention: string; choice: SummonIntentCategory }>> {
  return Promise.all(input.summons.map(async ({ start, end }) => {
    const text = input.body.slice(start, end);
    const answers = await evaluateRoutingChoices({ state: JSON.parse(JSON.stringify({ message: input.body,
      channelContext: input.channelContext, summon: { text, start, end, authorKind: "user" } })),
    questions: { intent: SUMMON_INTENT_QUESTION } }, input.evaluate, { budgetMs: 5_000 });
    const answer = answers.intent;
    if (!answer || !("choice" in answer)) throw new Error("Missing summon intent");
    return { start, end, mention: text, choice: answer.choice as SummonIntentCategory };
  }));
}

export function registerSummonIntentRoutes(app: Hono<{ Bindings: Env }>,
  authenticate: typeof requireAuth = requireAuth): void {
  /* While a Human types, Jev reads whether each summon in the draft asks an
     Agent to start, so the composer shows it before sending. Read-only: it
     allocates nothing and records no decision; the send carries the reading. */
  app.post("/api/channels/:channelId/summon-intent", (c) => jsonErrors(c, async () => {
    const authUser = requireHumanAuth(await authenticate(c.req.raw, c.env));
    const input = await c.req.json().catch(() => null) as { body?: unknown; summons?: unknown } | null;
    const body = input?.body;
    const summons = input?.summons;
    if (typeof body !== "string" || !body.trim() || body.length > MAX_DRAFT || !Array.isArray(summons) ||
        !summons.length || summons.length > MAX_SUMMONS || summons.some(item => !item || typeof item !== "object" ||
          !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 0 ||
          item.end <= item.start || item.end > body.length || item.end - item.start > 2_000)) {
      return c.json({ error: "body and up to 4 summon ranges in it are required" }, 400);
    }
    const apiKey = c.env.JEV_AI_GATEWAY_API_KEY?.trim();
    if (!apiKey) return c.json({ error: "summon_intent_unavailable" }, 503, NO_STORE);
    const channelId = c.req.param("channelId");
    const { database, directory } = runtimePlacement(c.env);
    const requestId = `summon-intent:${crypto.randomUUID()}`;
    const route = await new PostgresChannelSpaceDirectory(directory).resolve(
      { requestId, operation: "summon-intent.channel" }, channelId);
    if (!route) throw new RegistrationAccessError("registration_not_found", 404);
    // The reader's own Channel access bounds the context, as it does after sending.
    const channelContext = await registrationLaunchContextReader({ database, spaceId: route.spaceId, channelId,
      sourceMessageId: "draft", actorUserId: actorUserId(authUser) })(Number.MAX_SAFE_INTEGER);
    const readings = await readDraftSummonIntents({ body, channelContext,
      summons: summons.map(item => ({ start: Number(item.start), end: Number(item.end) })),
      evaluate: createJevClient({ apiKey, timeoutMs: 5_000 }).evaluate });
    return c.json({ readings }, 200, NO_STORE);
  }));
}
