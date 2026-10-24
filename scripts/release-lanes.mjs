// Release lanes. A Production Release deploys the service (the Hub and the
// Web) or publishes clients (CLI, Desktop, Android, iOS) that talk to the live
// Hub. Releases in one lane deploy one at a time, in version order. The
// service never waits for a client: no Hub or Web deploy reads what a client
// publication writes. A client waits for a Hub release dispatched before it,
// so the Hub it is admitted by (client-readiness) and published against is the
// one its train was cut beside. A release of both lanes waits for everything
// before it, and everything after it waits for it.
//
// The train applies this twice: planning defers client intents while a client
// release is active, so they do not hold the train in front of service
// changes (release-train.mjs), and dispatch waits only for the active releases
// its scope waits for (production-release-request.yml). Production Release
// takes a concurrency group per lane (production-release.yml).

export const SERVICE_COMPONENTS = Object.freeze(["hub", "web"]);
export const CLIENT_COMPONENTS = Object.freeze(["cli", "desktop", "android", "ios"]);

function components(scope) {
  if (Array.isArray(scope)) return scope;
  return String(scope ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * The lanes a release scope occupies, and whether it deploys the Hub. A scope
 * that cannot be read (no scope, or an unknown component) occupies both lanes
 * and the Hub, so nothing passes it.
 */
export function releaseLanes(scope) {
  const items = components(scope);
  const known = items.length > 0 &&
    items.every((item) => SERVICE_COMPONENTS.includes(item) || CLIENT_COMPONENTS.includes(item));
  if (!known) return { service: true, client: true, hub: true };
  return {
    service: items.some((item) => SERVICE_COMPONENTS.includes(item)),
    client: items.some((item) => CLIENT_COMPONENTS.includes(item)),
    hub: items.includes("hub"),
  };
}

/** Whether a train shipping `trainScope` waits for an active release of `activeScope`. */
export function waitsFor(trainScope, activeScope) {
  const train = releaseLanes(trainScope);
  const active = releaseLanes(activeScope);
  return (train.service && active.service) || (train.client && (active.client || active.hub));
}
