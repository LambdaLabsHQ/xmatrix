import type { AppConnectorEnv } from "./app-connectors";
import { registrationRepositoryCatalog } from "./registration-repository-catalog";
import { registrationLaunchContextReader } from "./registration-launch-context";
import { START_INTENT_DECLINED, registrationLaunchChooser } from "./registration-launch-choice";
import { REGISTRATION_PREPARATION_REJECTION_CODES, digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import type { RoutingEvaluator } from "./agent-routing-evaluation";
import type { AutoLaunchTags, DraftSummonIntent, SpaceAgentRegistrationKey } from "@xmatrix/protocol";
import {
  PostgresChannelSpaceDirectory, PostgresRegistrationLaunchRepository, PostgresRegistrationRebornRepository,
  PostgresSpacePlacementDirectory, PostgresRuntimeRepository, RegistrationAccessError, type AuthorityDatabase,
  PostgresFirstMessageLaunchChoiceRepository, PostgresMessageRepository,
} from "@xmatrix/db";
import { postgresProductMessage } from "./postgres-message-authority";
import { dispatchPreparedAgentLaunchWake } from "./product-agent-mention-authority-adapter";
import { scheduleAgentRoutingQuotaRefresh } from "./agent-routing-quota-refresh";
import { jevEvaluator, refreshChannelRoutingQuota, runtimePlacement } from "./runtime";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import type { Env } from "./types";

/** The Channel's active Space placement owns every registration launch in it. */
async function channelLaunchRepository(input: { database: AuthorityDatabase; directory: AuthorityDatabase;
  commandId: string; channelId: string; env?: AppConnectorEnv }) {
  const route = await new PostgresChannelSpaceDirectory(input.directory).resolve(
    { requestId: input.commandId, operation: "registration.launch.channel" }, input.channelId);
  if (!route) throw new RegistrationAccessError("registration_not_found", 404);
  const placement = await new PostgresSpacePlacementDirectory(input.directory).resolve(
    { requestId: input.commandId, operation: "registration.launch.placement" }, route.spaceId);
  if (placement.state !== "active" || placement.spaceId !== route.spaceId) {
    throw new RegistrationAccessError("registration_placement_unavailable", 503);
  }
  return { placement, repository: new PostgresRegistrationLaunchRepository(input.database, input.directory, {
    spaceId: placement.spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    input.env ? registrationRepositoryCatalog(input.env, input.database, placement.spaceId) : undefined) };
}

/** Jev for one launch decision, in the Space its Channel is placed in. */
type LaunchEvaluator = (spaceId: string) => RoutingEvaluator;

export async function executeRegistrationLaunchDispatch(input: {
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; evaluatorFor?: LaunchEvaluator;
  commandId: string; actorUserId: string; channelId: string; sourceMessageId: string; body: string;
  /** The author's "launch anyway" for one summon Jev read as a non-request. */
  forceMention?: string;
  draftIntents?: DraftSummonIntent[];
}) {
  const { placement, repository } = await channelLaunchRepository(input);
  const result = await repository.dispatchFromMessage(input, input.evaluatorFor ? registrationLaunchChooser(input.evaluatorFor(placement.spaceId), registrationLaunchContextReader({
    ...input, spaceId: placement.spaceId,
  })) : undefined);
  if (result.rejected.length) {
    await new PostgresRuntimeRepository(input.database).recordRoutingRejections({
      channelId: input.channelId, sourceMessageId: input.sourceMessageId, actorUserId: input.actorUserId,
      rejected: result.rejected.map(item => ({ sourceMention: item.sourceMention,
        // Keep the typed domain code so diagnose names the actual cause; only
        // an untyped value collapses to the generic rejection.
        code: REGISTRATION_PREPARATION_REJECTION_CODES.includes(item.code) || /^[a-z][a-z0-9_]{2,79}$/u.test(item.code)
          ? item.code : "registration_launch_rejected",
        ...(item.tooOld ? { tooOld: item.tooOld } : {}) })),
    });
  }
  return { ...result, shardId: placement.shardId, channelId: input.channelId };
}

interface RegistrationInputLaunch {
  runId: string; instanceId: string; launchId: string; agentName: string; hostId: string; reused: boolean;
}

/** What any-input launch callers state, whichever side of the relay they are on. */
interface RegistrationInputRequest {
  /** Exclude the stable registration bound to this predecessor Instance. */
  excludeSourceInstanceId?: string;
  /** Exclude an environment that just failed to start this work. */
  excludeRegistration?: SpaceAgentRegistrationKey;
  commandId: string; actorUserId: string; channelId: string; body: string; runMetadata?: Record<string, unknown>;
  runId?: string; instanceId?: string;
  initialMessageId?: string; presentationMessageId?: string; tags?: AutoLaunchTags;
  /** Capabilities the work needs; those a daemon can prove gate where it runs. */
  requiredCapabilities?: readonly string[];
}

/** Launch from any input. Jev chooses among every authorized registration in
 * the Channel's Space; no source message is required. */
export async function executeRegistrationInputDispatch(input: RegistrationInputRequest & {
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; evaluatorFor: LaunchEvaluator;
}) {
  const { placement, repository } = await channelLaunchRepository(input);
  const prepared = await repository.dispatchInput(input, registrationLaunchChooser(input.evaluatorFor(placement.spaceId)));
  return { ...prepared, shardId: placement.shardId, channelId: input.channelId };
}

/** Its author now sees the choice on their new conversation's first message:
 * the window restarts from now, within the hold limit. */
export async function showFirstMessageLaunch(input: { database: AuthorityDatabase; directory: AuthorityDatabase;
  commandId: string; actorUserId: string; channelId: string; messageId: string; body: string }) {
  const { placement } = await channelLaunchRepository(input);
  return new PostgresFirstMessageLaunchChoiceRepository(input.database, {
    spaceId: placement.spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch,
  }).show({ requestId: input.commandId, channelId: input.channelId, messageId: input.messageId,
    actorUserId: input.actorUserId, body: input.body });
}

/** The author's pick for their new conversation's first message, written as
 * its one decision; `harness` absent is "start nothing". */
export async function claimFirstMessageLaunch(input: { database: AuthorityDatabase; directory: AuthorityDatabase;
  commandId: string; actorUserId: string; channelId: string; messageId: string; body: string; harness?: string }) {
  const { placement } = await channelLaunchRepository(input);
  const choices = new PostgresFirstMessageLaunchChoiceRepository(input.database, {
    spaceId: placement.spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch });
  return choices.claim({ requestId: input.commandId, channelId: input.channelId, messageId: input.messageId,
    by: "author", actorUserId: input.actorUserId, body: input.body, ...(input.harness ? { harness: input.harness } : {}) });
}

/** What decided a first message: `harness` absent is "start nothing". */
export interface FirstMessageDecision { claimed: boolean; harness?: string }

/**
 * Jev's decision on a new conversation's first message that summons nobody.
 * A Human's message gives its author a window: Jev's reading waits it out and
 * then races the author for the one decision. Nothing is launched here; a
 * decided harness is summoned by an ordinary `@<harness>` message.
 */
export async function executeFirstMessageDecision(input: {
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; evaluatorFor: LaunchEvaluator;
  commandId: string; actorUserId: string; channelId: string; messageId: string; body: string;
  /** The author is a Human, who may choose first. */
  window: boolean;
  /** The decision's row exists: hand its unfinished summon to the Channel's coordinator. */
  opened?: () => Promise<void>;
}): Promise<FirstMessageDecision> {
  const { placement, repository } = await channelLaunchRepository(input);
  const choose = registrationLaunchChooser(input.evaluatorFor(placement.spaceId));
  const read = (onHarness?: (harness: string) => Promise<void>) => repository.readHarnessToStart({
    actorUserId: input.actorUserId, body: input.body, ...(onHarness ? { onHarness } : {}) }, choose);
  // Both authors persist the same decision before the system summon can be
  // authorized. The database gives Agent publications an immediate deadline.
  return decideFirstMessageLaunch({ ...input, read, choices: new PostgresFirstMessageLaunchChoiceRepository(input.database, {
    spaceId: placement.spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch }) });
}

type FirstMessageChoices = Pick<PostgresFirstMessageLaunchChoiceRepository, "open" | "recommend" | "claim" | "fail">;

/**
 * Jev's reading is written once, as soon as Jev knows the harness: the
 * author's window starts there. Once it closes unchosen, Jev claims the
 * decision; if the author chose first, Jev's reading decides nothing.
 */
export async function decideFirstMessageLaunch(input: {
  commandId: string; actorUserId: string; channelId: string; messageId: string; choices: FirstMessageChoices;
  read: (onHarness: (harness: string) => Promise<void>) => Promise<string>;
  opened?: () => Promise<void>;
}, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
): Promise<FirstMessageDecision> {
  const request = (step: string) => `${input.commandId}:${step}`.slice(0, 200);
  const where = { channelId: input.channelId, messageId: input.messageId };
  const window = await input.choices.open({ requestId: request("open"), ...where, authorUserId: input.actorUserId });
  await input.opened?.();
  if (window.chosenBy === "author") return { claimed: false };
  let reading: Promise<{ deadlineAt: string }> | undefined;
  const recommend = (harness?: string) => reading ??= input.choices.recommend({ requestId: request("recommend"), ...where,
    ...(harness ? { harness } : {}) });
  try {
    let harness: string | undefined;
    try { harness = await input.read(picked => recommend(picked).then(() => undefined)); }
    // Jev read the message as conversation: once the window closes unchosen, nothing starts.
    catch (error) { if (!(error instanceof RegistrationAccessError) || error.code !== START_INTENT_DECLINED) throw error; }
    // The author seeing the reading moves the deadline on, so re-read it on every try.
    let { deadlineAt } = await recommend(harness);
    for (let attempt = 0; ; attempt++) {
      const remaining = Date.parse(deadlineAt) - now();
      if (remaining > 0) await wait(remaining);
      try {
        const { claimed } = await input.choices.claim({ requestId: request(`claim:${attempt}`), ...where, by: "jev",
          actorUserId: input.actorUserId, ...(harness ? { harness } : {}) });
        return { claimed, ...(claimed && harness ? { harness } : {}) };
      } catch (error) {
        if (!(error instanceof RegistrationAccessError) || error.code !== "launch_choice_window_open" || attempt >= 20) throw error;
        const current = await input.choices.open({ requestId: request(`reopen:${attempt}`), ...where, authorUserId: input.actorUserId });
        if (current.chosenBy === "author") return { claimed: false };
        // The database clock may also run a little behind this one.
        deadlineAt = Date.parse(current.deadlineAt) > now() ? current.deadlineAt : new Date(now() + 250).toISOString();
      }
    }
  } catch (error) {
    // Nothing will be decided: the message says why instead of reading forever.
    await input.choices.fail({ requestId: request("fail"), ...where,
      failureCode: error instanceof RegistrationAccessError ? error.code : "registration_launch_rejected" }).catch(() => undefined);
    throw error;
  }
}

/** Prepares the wake of every resting Instance in a Channel; the Channel's
 * coordinator carries the prepared wakes from there. */
export async function wakeRestingInstances(env: Env, input: {
  commandId: string; channelId: string; sourceMessageId: string; prompt: string;
}) {
  const value = await executeRestingInstanceWake({ ...runtimePlacement(env), ...input });
  if (value.woken.length > 0) await wakeAgentLaunchCoordinator(env, input.channelId, ["reborn", "launch"]);
  return value;
}

/** Holds a source Instance whose provider quota ran out until its window resets. */
export function holdRegistrationUsageLimit(env: Env, input: {
  commandId: string; actorUserId: string; channelId: string; sourceInstanceId: string; resetsAt?: string;
}) {
  return executeRegistrationUsageLimitHold({ ...runtimePlacement(env), ...input });
}

/** A reborn of a source Instance as a fresh registration Run of its tuple. */
export function prepareRegistrationReborn(env: Env, input: {
  commandId: string; actorUserId: string; channelId: string; sourceMessageId: string;
  sourceInstanceId: string; sourceMention?: string; prompt: string;
}) {
  return executeRegistrationRebornPrepare({ ...runtimePlacement(env), ...input });
}

/** Jev decides whether a new conversation's first message asks for an Agent;
 * a Human author may choose first within the window. */
export function decideNewConversationLaunch(env: Env, input: {
  commandId: string; actorUserId: string; channelId: string; messageId: string; body: string; window: boolean;
}) {
  const evaluatorFor = jevEvaluator(env, { feature: "start_intent", actorUserId: input.actorUserId,
    channelId: input.channelId, sourceMessageId: input.commandId, invocationId: input.commandId });
  if (!evaluatorFor) throw new RegistrationAccessError("registration_selection_unconfigured", 503);
  // The request deciding this may end before its summon does (a background
  // budget runs out); the coordinator then finishes it once it is due.
  return executeFirstMessageDecision({ ...runtimePlacement(env), evaluatorFor, ...input,
    opened: () => wakeAgentLaunchCoordinator(env, input.channelId, ["firstMessageSummon"]).catch(error =>
      console.warn("First message summon handover failed", { channelId: input.channelId, messageId: input.messageId,
        error: error instanceof Error ? error.message : String(error) })) });
}

/** xMatrix's summon of a decided first message finished dispatching. */
export async function markFirstMessageSummoned(env: Env, input: { channelId: string; messageId: string }): Promise<void> {
  const { database, directory } = runtimePlacement(env);
  const commandId = `first-message-summoned:${input.messageId}`.slice(0, 200);
  const { placement } = await channelLaunchRepository({ database, directory, commandId, channelId: input.channelId });
  await new PostgresFirstMessageLaunchChoiceRepository(database, { spaceId: placement.spaceId, shardId: placement.shardId,
    placementEpoch: placement.placementEpoch }).summoned({ requestId: commandId, ...input });
}

/** The body of a Channel's first message, read as its author. */
export async function readFirstMessageBody(env: Env, input: { channelId: string; messageId: string; authorUserId: string }) {
  const { database, directory } = runtimePlacement(env);
  const commandId = `first-message-body:${input.messageId}`.slice(0, 200);
  const { placement } = await channelLaunchRepository({ database, directory, commandId, channelId: input.channelId });
  const page = await new PostgresMessageRepository(database).history({ requestId: commandId, spaceId: placement.spaceId,
    principal: { kind: "user", id: input.authorUserId }, channelId: input.channelId, beforeSequence: 2, limit: 1 });
  const message = page.messages.map(postgresProductMessage).find(item => Number(item.sequence) === 1);
  if (message?.messageId !== input.messageId || typeof message.body !== "string") return undefined;
  const from = message.from as { kind?: unknown } | undefined;
  return { body: message.body, authorKind: from?.kind === "agent" ? "agent" as const : "user" as const };
}

/** Hub-side caller for any-input launches; wakes the daemon after the durable prepare. */
export async function dispatchRegistrationInput(input: RegistrationInputRequest & {
  env: Env;
}): Promise<RegistrationInputLaunch> {
  const { env, ...request } = input;
  const evaluatorFor = jevEvaluator(env, { feature: "input_launch", actorUserId: request.actorUserId,
    channelId: request.channelId, sourceMessageId: request.commandId, invocationId: request.commandId });
  if (!evaluatorFor) throw new RegistrationAccessError("registration_selection_unconfigured", 503);
  const result = await executeRegistrationInputDispatch({ ...runtimePlacement(env), evaluatorFor, ...request }) as
    RegistrationInputLaunch & { shardId?: string };
  // The launch is answered only once its Channel's coordinator owns it; the
  // caller's retry of the same command recovers the prepare and wakes again.
  await dispatchPreparedAgentLaunchWake({
    channels: env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL,
    channelId: request.channelId, launchIds: [result.launchId],
    ...(typeof result.shardId === "string" ? { shardId: result.shardId } : {}),
  });
  return { runId: result.runId, instanceId: result.instanceId, launchId: result.launchId,
    agentName: result.agentName, hostId: result.hostId, reused: result.reused };
}

/**
 * A Run that failed to start for an `@auto` summon, or for xMatrix's summon of
 * a first message that named nobody, hands the same message to the next-ranked
 * Agent, once: the retry is an any-input launch, which has no retry of its
 * own. The failed environment is excluded; the author's other conditions
 * still bind. One command per failed Run, so a replay recovers the same launch.
 * Undefined when the Run has no such origin or nothing else can take the work.
 */
export async function dispatchStartupFallback(env: Env, input: { channelId: string; runId: string },
  dispatch: typeof dispatchRegistrationInput = dispatchRegistrationInput): Promise<{ agentName: string } | undefined> {
  const { database, directory } = runtimePlacement(env);
  const commandId = `startup-fallback:${input.runId}`.slice(0, 200);
  const { placement, repository } = await channelLaunchRepository({ database, directory, commandId, channelId: input.channelId });
  const origin = await repository.startupFallbackOrigin({ commandId, channelId: input.channelId, runId: input.runId,
    readBody: async (actorUserId, sourceSequence) => {
      const page = await new PostgresMessageRepository(database).history({ requestId: commandId, spaceId: placement.spaceId,
        principal: { kind: "user", id: actorUserId }, channelId: input.channelId, beforeSequence: sourceSequence + 1, limit: 1 });
      const message = page.messages.map(postgresProductMessage).find(item => item.sequence === sourceSequence);
      return typeof message?.body === "string" ? message.body : undefined;
    } });
  if (!origin) return undefined;
  try {
    const launched = await dispatch({ env, commandId, actorUserId: origin.actorUserId, channelId: input.channelId,
      body: origin.body, tags: origin.tags, excludeRegistration: origin.failed,
      // The retry answers the same message and is drawn on its summon, like the launch it replaces.
      initialMessageId: origin.sourceMessageId, presentationMessageId: origin.sourceMessageId,
      runMetadata: { sourceMention: origin.sourceMention } });
    return { agentName: launched.agentName };
  } catch (error) {
    // Nothing else can take the work, or routing could not choose now: the
    // failure notice stands on its own rather than a retry arriving late.
    if (error instanceof RegistrationAccessError) return undefined;
    throw error;
  }
}

/** The reborn/handoff repository placed on the Channel's Space shard. */
async function placedRebornRepository(input: { env?: AppConnectorEnv; database: AuthorityDatabase;
  directory: AuthorityDatabase; commandId: string; channelId: string }, operation: "reborn" | "handoff") {
  const route = await new PostgresChannelSpaceDirectory(input.directory).resolve(
    { requestId: input.commandId, operation: `registration.${operation}.channel` }, input.channelId);
  if (!route) throw new RegistrationAccessError("registration_not_found", 404);
  const placement = await new PostgresSpacePlacementDirectory(input.directory).resolve(
    { requestId: input.commandId, operation: `registration.${operation}.placement` }, route.spaceId);
  if (placement.state !== "active" || placement.spaceId !== route.spaceId) {
    throw new RegistrationAccessError("registration_placement_unavailable", 503);
  }
  return new PostgresRegistrationRebornRepository(input.database, input.directory, {
    spaceId: placement.spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch,
  });
}

/** Reborn: the successor is a registration Run of the predecessor's tuple. A
 * refusal is a coded `RegistrationAccessError` the caller reports. */
export async function executeRegistrationRebornPrepare(input: {
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; commandId: string; actorUserId: string;
  channelId: string; sourceMessageId: string; sourceInstanceId: string; sourceMention?: string; prompt: string;
}) {
  return (await placedRebornRepository(input, "reborn")).prepare(input);
}

/** Wake: every resting Instance in the Channel resumes for one committed
 * message through its own reborn (docs/instance-sleep.md §3). */
export async function executeRestingInstanceWake(input: {
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; commandId: string;
  channelId: string; sourceMessageId: string; prompt?: string;
}) {
  return (await placedRebornRepository(input, "reborn")).wakeResting(input);
}

/** The source Instance's provider account is used up: its pool is held empty
 * until the reset. Moving its work is a separate `handoff:@auto`. */
export async function executeRegistrationUsageLimitHold(input: {
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; commandId: string; actorUserId: string;
  channelId: string; sourceInstanceId: string; resetsAt?: string;
}) {
  return (await placedRebornRepository(input, "handoff")).holdUsageLimit(input);
}

interface MessageLaunch {
  env: Env; channelId: string; messageId: string; body: string; actorUserId: string;
  commandId: string; forceMention?: string; draftIntents?: DraftSummonIntent[];
}

interface MessageLaunchResult {
  selectionCount?: number; shardId?: string;
  prepared?: Array<{ launchId: string }>; rejected?: Array<{ code: string }>;
}

type MessageLaunchDependencies = {
  launch?: (input: MessageLaunch) => Promise<MessageLaunchResult>;
  refreshQuota?: (input: { env: Env; channelId: string; actorUserId: string }) => Promise<unknown>;
};

/** The registration dispatch for one stored message, with Jev when it is configured. */
function launchFromMessage(input: MessageLaunch): Promise<MessageLaunchResult> {
  const { env, messageId, ...launch } = input;
  return executeRegistrationLaunchDispatch({ ...runtimePlacement(env), ...launch, sourceMessageId: messageId,
    evaluatorFor: jevEvaluator(env, { feature: "launch_choice", actorUserId: input.actorUserId,
      channelId: input.channelId, sourceMessageId: messageId, invocationId: input.commandId }) });
}

/** One registration dispatch from a stored message, then the daemon wake for
 * whatever it prepared. */
async function dispatchFromMessage(input: MessageLaunch, dependencies: MessageLaunchDependencies) {
  const result = await (dependencies.launch ?? launchFromMessage)(input);
  const prepared = Array.isArray(result.prepared) ? result.prepared.filter(item => typeof item.launchId === "string") : [];
  if (prepared.length) {
    await dispatchPreparedAgentLaunchWake({
      channels: input.env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL,
      channelId: input.channelId, launchIds: prepared.map(item => item.launchId),
      ...(typeof result.shardId === "string" ? { shardId: result.shardId } : {}),
    });
  }
  return { prepared, selectionCount: Number(result.selectionCount) || 0,
    rejected: Array.isArray(result.rejected) ? result.rejected : [] };
}

export async function dispatchRegistrationLaunchesAfterMessage(input: {
  env: Env; channelId: string; messageId: string; body: string; actorUserId: string;
  draftIntents?: DraftSummonIntent[];
  scheduleBackground?: (task: Promise<unknown>) => void;
}, dependencies: MessageLaunchDependencies = {},
): Promise<{ selectionCount: number; prepared: Array<{ launchId: string }>; rejected?: Array<{ code: string }> }> {
  const result = await dispatchFromMessage({ ...input, commandId: `registration-launch:${input.messageId}` }, dependencies);
  if (result.selectionCount > 0) {
    // Jev chose from persisted quota facts; refresh them (including the
    // Space's registrations) for the next choice without delaying this one.
    scheduleAgentRoutingQuotaRefresh(() => (dependencies.refreshQuota ?? (({ env, ...channel }) =>
      refreshChannelRoutingQuota(env, channel)))({
      env: input.env, channelId: input.channelId, actorUserId: input.actorUserId,
    }), input.scheduleBackground);
  }
  return { selectionCount: result.selectionCount, prepared: result.prepared, rejected: result.rejected };
}

/** "Launch anyway": the source message's author answers the intent question
 * for one summon Jev declined. Message authority, fences and every other check
 * are the ordinary registration dispatch; only this summon is prepared. */
export async function dispatchRegistrationLaunchAnyway(input: {
  env: Env; channelId: string; messageId: string; body: string; actorUserId: string; sourceMention: string;
}, dependencies: MessageLaunchDependencies = {},
): Promise<{ prepared: Array<{ launchId: string }>; rejected: Array<{ code: string }> }> {
  const result = await dispatchFromMessage({ ...input, forceMention: input.sourceMention,
    // One stable command per summon: a repeated press recovers the same launch.
    commandId: `registration-launch-anyway:${input.messageId}:${await digestCanonicalCloneCborV1(input.sourceMention)}`.slice(0, 200),
  }, dependencies);
  return { prepared: result.prepared, rejected: result.rejected };
}
