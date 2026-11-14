import type { HarnessSignedOut } from "@xmatrix/protocol";
import { publishStartupFallbackNotice } from "./machine-run-failure-notice";
import { dispatchStartupFallback } from "./registration-launch-dispatch";
import { runtimeRepository } from "./runtime";
import type { Env } from "./types";

/** What a signed-out refusal's notice offers: the program to sign in, and the
 * summon to send again once it is, when one is still owed its answer. */
export interface SignedOutRefusal {
  signedOut: HarnessSignedOut;
  /** The Run has not replied: what it was started for is still unanswered. */
  unanswered?: boolean;
  summon?: { sourceMessageId: string; sourceMention: string };
}

/**
 * A turn its program refused as signed out. Whether a program is signed in is
 * the program's own to say, each time it is given work: nothing is recorded,
 * and routing asks nothing before the next summon. What follows belongs to
 * this one request. A Run that never replied leaves its work unanswered: an
 * `@auto` message, or a handoff, goes on to the next Agent
 * (dispatchStartupFallback); a summon that named this Agent is sent again from
 * the notice when its program is signed in.
 */
export async function signedOutTurn(env: Env, run: { runId: string; channelId: string; ownerUserId: string },
  dependencies: { read?: (runId: string, ownerUserId: string) => Promise<SignedOutRefusal | undefined>;
    fallback?: typeof dispatchStartupFallback; handedOn?: typeof publishStartupFallbackNotice } = {},
): Promise<SignedOutRefusal | undefined> {
  const refused = await (dependencies.read ?? ((runId, ownerUserId) => runtimeRepository(env).signedOutRunHarness({
    requestId: crypto.randomUUID(), runId, actorUserId: ownerUserId })))(run.runId, run.ownerUserId);
  if (!refused?.unanswered) return refused;
  const handed = await (dependencies.fallback ?? dispatchStartupFallback)(env, { channelId: run.channelId, runId: run.runId });
  if (!handed) return refused;
  await (dependencies.handedOn ?? publishStartupFallbackNotice)(env, { runId: run.runId, channelId: run.channelId,
    agentName: handed.agentName, ownerUserId: run.ownerUserId, ownerEmail: `${run.ownerUserId}@unknown.invalid`,
    ...(refused.summon ? { sourceMessageId: refused.summon.sourceMessageId } : {}) });
  // Another Agent has the message: signing this one in sends nothing again.
  return { signedOut: refused.signedOut };
}
