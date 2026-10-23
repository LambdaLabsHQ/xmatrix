import type { Hono } from "hono";
import {
  HUB_ROUTES, parseDesktopDaemonFailureReport, parseOnboardingFunnelEvent,
  type DesktopDaemonFailureReport, type OnboardingFunnelEvent,
} from "@xmatrix/protocol";
import type { Env } from "./types";
import { diagnosticsDataPoint } from "./diagnostics";
import { jsonErrors, requireAuth, requireHumanAuth } from "./index-shared";

/**
 * What only the person's own screen or machine sees of getting started
 * (docs/architecture/first-space.md): a step of bringing agents in, and a
 * desktop App that could not start its background service. One point per
 * report in the diagnostics dataset, under the person's keyed hash: no email,
 * no Space or conversation.
 */
export function registerOnboardingFunnelRoutes(app: Hono<{ Bindings: Env }>): void {
  // The funnel counts distinct people, so a repeated step adds nobody.
  diagnosticsReportRoute(app, HUB_ROUTES.observable_onboarding_step, parseOnboardingFunnelEvent,
    { error: "Not an onboarding step", code: "invalid_onboarding_step" }, onboardingStepDataPoint);
  // The App's logs stay on the machine; this is the only copy the Hub sees.
  diagnosticsReportRoute(app, HUB_ROUTES.observable_desktop_daemon_failure, parseDesktopDaemonFailureReport,
    { error: "Not a daemon start failure", code: "invalid_daemon_failure" }, desktopDaemonFailureDataPoint);
}

function diagnosticsReportRoute<T>(
  app: Hono<{ Bindings: Env }>,
  route: string,
  parse: (value: unknown) => T | undefined,
  refusal: { error: string; code: string },
  dataPoint: (report: T, userId: string, hashKey: string | undefined) => Promise<AnalyticsEngineDataPoint>,
): void {
  app.post(route, (c) => jsonErrors(c, async () => {
    const person = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const report = parse(await c.req.json().catch(() => undefined));
    if (!report) return c.json(refusal, 400);
    if (!c.env.DIAGNOSTICS_AE) return c.json({ error: "telemetry sink unavailable", code: "telemetry_unavailable" }, 503);
    c.env.DIAGNOSTICS_AE.writeDataPoint(await dataPoint(report, person.id,
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

/** index1 the person's keyed hash; blob1 `desktop`, blob2 the platform, blob3
 * `daemon_start_failed`, blob4 the stage, blob5 the App version, blob11 the
 * CLI's last lines; double3 the exit code (-1 when there was none). */
export async function desktopDaemonFailureDataPoint(report: DesktopDaemonFailureReport, userId: string, hashKey: string | undefined) {
  const point = await diagnosticsDataPoint({ userId, hashKey, routeGroup: "desktop", eventType: "daemon_start_failed",
    clientKind: report.platform, reason: report.stage, status: report.appVersion });
  return { ...point, blobs: [...point.blobs ?? [], report.detail], doubles: [...point.doubles ?? [], report.exitCode ?? -1] };
}
