// Which Production Releases may deploy side by side, from the dependencies
// between the components they ship. Nothing else serializes them.
//
// A release waits for an active one when it ships a component that release
// also ships (one component deploys in version order: a later deploy that
// finished first would be overwritten, and channel pointers only move
// forward), or when that release ships a component it depends on: the Web is
// built for the Hub of its train; a client is admitted by that Hub and
// published against it; the Desktop, Android and iOS apps are shells around
// the live Web of their channel, so they publish after it, as they do inside
// one release (client-readiness); Desktop bundles the CLI. Releases that touch
// neither run at once: a Web beside a CLI, Android beside iOS, a Hub beside
// any client.
//
// The train applies this twice: dispatch waits only for the active releases a
// train's scope waits for (production-release-request.yml), and planning
// leaves open the intents that would wait long, so they do not hold the train
// in front of changes that could ship now (release-train.mjs).

// The components each component depends on, transitively.
export const DEPENDS_ON = Object.freeze({
  hub: Object.freeze([]),
  web: Object.freeze(["hub"]),
  cli: Object.freeze(["hub"]),
  desktop: Object.freeze(["hub", "web", "cli"]),
  android: Object.freeze(["hub", "web"]),
  ios: Object.freeze(["hub", "web"]),
});

// How long a release of each component takes to its receipt, in minutes: the
// recent p90 (2026-10-22..24), rounded up. A release takes the longest of its
// components, which build and publish side by side.
export const RELEASE_MINUTES = Object.freeze({ hub: 6, web: 8, cli: 14, desktop: 25, android: 15, ios: 20 });

// A train that ships an intent waiting for an active release holds the train
// until that release finishes: its gates run meanwhile, but no later train can
// plan. It does so only for a release expected to finish within this; an
// intent behind a longer one stays open for the train that release wakes.
export const HOLD_MINUTES = 8;

function components(scope) {
  if (Array.isArray(scope)) return scope;
  return String(scope ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** The components of a scope, or null when it cannot be read (no scope, or an unknown component). */
function known(scope) {
  const items = components(scope);
  return items.length && items.every((item) => Object.hasOwn(DEPENDS_ON, item)) ? items : null;
}

/**
 * Whether a train shipping `trainScope` waits for an active release of
 * `activeScope`. A scope that cannot be read, on either side, waits.
 */
export function waitsFor(trainScope, activeScope) {
  const train = known(trainScope);
  const active = known(activeScope);
  if (!train || !active) return true;
  const needs = new Set(train.flatMap((component) => [component, ...DEPENDS_ON[component]]));
  return active.some((component) => needs.has(component));
}

/**
 * The Production Release concurrency group of a scope (production-release.yml
 * computes the same): its first component in dependency order, so a release
 * with the Hub holds production-release-train, the group Production Release
 * Recovery acquires. Two releases with one group share that component, so
 * each waits for the other and the train never dispatches them side by side;
 * the group only backs that up when a stale run list hides one of them.
 */
export function releaseGroup(scope) {
  const items = known(scope);
  const first = items ? Object.keys(DEPENDS_ON).find((component) => items.includes(component)) : "hub";
  return first === "hub" ? "production-release-train" : `production-release-${first}`;
}

/** Minutes a release of `scope` is expected to take; a scope that cannot be read takes the longest. */
export function releaseMinutes(scope) {
  const items = known(scope) ?? Object.keys(RELEASE_MINUTES);
  return Math.max(...items.map((component) => RELEASE_MINUTES[component]));
}

/**
 * Pure: the betas a train ships beside the releases still running
 * (`active`: { scope, startedAt }). A beta that waits for an active release
 * expected to run longer than HOLD_MINUTES stays open in `deferred`; the
 * release wakes the train when it finishes, and that train takes it.
 */
export function deferWaitingIntents(eligible, active, now = Date.now()) {
  const remaining = (release) => releaseMinutes(release.scope) -
    Math.max(0, (now - (Date.parse(release.startedAt ?? "") || now)) / 60_000);
  const long = active.filter((release) => remaining(release) > HOLD_MINUTES);
  const deferred = eligible.filter((intent) => long.some((release) => waitsFor(intent.scope, release.scope)));
  const shipping = eligible.filter((intent) => !deferred.includes(intent));
  const selected = new Set(shipping.flatMap((intent) => intent.scope));
  return { eligible: shipping, deferred, scope: Object.keys(DEPENDS_ON).filter((component) => selected.has(component)) };
}
