// Vendored from norn-lang/norn@96c71706b2dd17ca23bd39d62d9e373b7cc20f14; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Names the first draft of the language had and the language no longer does
 * (spec §15). Using one is an ordinary unknown-name, unknown-constructor,
 * unknown-type or unknown-label error, with a hint that names what to write
 * instead.
 */

export const REMOVED_NAMES: ReadonlyMap<string, string> = new Map([
  ["request", "request was removed: every verb returns a request; use ask and ->wait"],
  ["start", "start was removed: run returns a request; use run and ->wait"],
  ["merge", "merge was removed: a->or(b) keeps both values, as First(x) and Second(y)"],
]);

export const REMOVED_CONSTRUCTORS: ReadonlyMap<string, string> = new Map([
  ["Done", "Done was removed: a request's answer is Answered(x)"],
  ["Declined", "Declined was removed: a participant who declines gives Refused(why)"],
  ["Failed", "Failed was removed: a participant who tried and could not gives Broke(why)"],
  ["TimedOut", "TimedOut was removed: a request's own ~by deadline gives NoReply, and a wait that runs out with ->waitUntil gives None"],
]);

export const REMOVED_TYPES: ReadonlyMap<string, string> = new Map([
  ["outcome", "outcome was removed: a request's result is a reply<'a>, and a fact or a stream gives its value"],
]);

/** A labelled argument the first draft had, on the built-in `callee`; null when the label never existed there. */
export function removedLabel(callee: string, label: string): string | null {
  if (label === "options" && callee === "ask") return "ask(…, ~options=…) was removed: use choose(who, question, [A, B]), or confirm(who, question) for a yes or a no";
  if (label === "until" && ["ask", "confirm", "choose", "run"].includes(callee)) {
    return `~until was removed: a request's own deadline is ~by, as in ${callee}(…, ~by=1h); to stop waiting without ending the request, use ->waitUntil(t)`;
  }
  if (label === "until" && callee === "wait") return "wait(x, ~until=t) was removed: use x->waitUntil(t), which gives None if t passes first";
  return null;
}
