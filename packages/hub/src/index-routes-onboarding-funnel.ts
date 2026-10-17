import type { Hono } from "hono";
import { HUB_ROUTES, parseOnboardingFunnelEvent, type OnboardingFunnelEvent } from "@xmatrix/protocol";
import type { Env } from "./types";
import { diagnosticsDataPoint } from "./diagnostics";
import { jsonErrors, requireAuth, requireHumanAuth } from "./index-shared";

/**
 * Counts a step of bringing agents in that only the person's screen saw
 * (docs/architecture/first-space.md, "Counting who gets through"). One point
 * per report in the diagnostics dataset, under the person's keyed hash: no
 * email, no Space or conversation, nothing but the step, where it was shown
 * and on what. The funnel counts distinct people, so a repeated report adds
 * nobody.
 */
export function registerOnboardingFunnelRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(HUB_ROUTES.observable_onboarding_step, (c) => jsonErrors(c, async () => {
    const person = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const event = parseOnboardingFunnelEvent(await c.req.json().catch(() => undefined));
    if (!event) return c.json({ error: "Not an onboarding step", code: "invalid_onboarding_step" }, 400);
    if (!c.env.DIAGNOSTICS_AE) return c.json({ error: "telemetry sink unavailable", code: "telemetry_unavailable" }, 503);
    c.env.DIAGNOSTICS_AE.writeDataPoint(await onboardingStepDataPoint(event, person.id,
      c.env.DIAGNOSTICS_HASH_SECRET || c.env.BETTER_AUTH_SECRET));
    return c.body(null, 204);
  }));
}

/** One step as the funnel query reads it: index1 the person's keyed hash, then
 * blob1 `onboarding`, blob2 the device, blob3 `onboarding_step`, blob4 the
 * step (`starter_chosen:<starter>` for a first task) and blob5 the surface. */
export function onboardingStepDataPoint(event: OnboardingFunnelEvent, userId: string, hashKey: string | undefined) {
  return diagnosticsDataPoint({ userId, hashKey, routeGroup: "onboarding", eventType: "onboarding_step",
    clientKind: event.device, status: event.surface, reason: event.starter ? `${event.step}:${event.starter}` : event.step });
}
