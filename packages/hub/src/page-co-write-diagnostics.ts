import { diagnosticsDataPoint, diagnosticsEntityHash } from "./diagnostics";
import type { PageCoWriteObservation } from "./page-co-write-timing";
import type { PageSessionPrincipal } from "./page-session";

/** The authenticated co-writer owns attribution; no page text, labels or raw identifiers leave the session. */
export async function pageCoWriteDataPoint(
  principal: PageSessionPrincipal, pageId: string, event: PageCoWriteObservation, hashKey: string | undefined,
): Promise<AnalyticsEngineDataPoint> {
  const point = await diagnosticsDataPoint({ userId: principal.ownerUserId, agentId: principal.id, hashKey,
    routeGroup: "pages", clientKind: "hub", eventType: `cowrite_${event.event}`, reason: event.outcome,
    status: "session_clock", durationMs: event.durationMs, spawnSignature: `${pageId}:${principal.id}:${event.turn}` });
  const session = principal.conversationId ? `${pageId}:${principal.conversationId}` : undefined;
  return { ...point, blobs: [...point.blobs ?? [], await diagnosticsEntityHash(session, hashKey)],
    doubles: [...point.doubles ?? [],
    event.editToTurnMs ?? -1, event.firstDeltaMs ?? -1, event.firstTextMs ?? -1,
    event.editToFirstTextMs ?? -1, event.maxWriteGapMs ?? -1, event.writes] };
}
