import type { AppConnectorEnv } from "./app-connectors";
import { registrationRepositoryCatalog } from "./registration-repository-catalog";
import { registrationLaunchContextReader } from "./registration-launch-context";
import { START_INTENT_DECLINED, registrationLaunchChooser } from "./registration-launch-choice";
import { REGISTRATION_PREPARATION_REJECTION_CODES, digestCanonicalCloneCborV1, isAutoHandoffSuccessor } from "@xmatrix/protocol";
import type { RoutingEvaluator } from "./agent-routing-evaluation";
import type { AutoLaunchTags } from "@xmatrix/protocol";
import {
  PostgresChannelSpaceDirectory, PostgresRegistrationLaunchRepository, PostgresRegistrationRebornRepository,
  PostgresSpacePlacementDirectory, PostgresRuntimeRepository, RegistrationAccessError, type AuthorityDatabase,
  PostgresFirstMessageLaunchChoiceRepository,
  type RegistrationAboutSession,
  type ChannelAboutSessionStopTarget,
} from "@xmatrix/db";
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

export async function executeRegistrationLaunchDispatch(input: {
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; evaluate?: RoutingEvaluator;
  commandId: string; actorUserId: string; channelId: string; sourceMessageId: string; body: string;
  /** The author's "launch anyway" for one summon Jev read as a non-request. */
  forceMention?: string;
}) {
  const { placement, repository } = await channelLaunchRepository(input);
  const result = await repository.dispatchFromMessage(input, input.evaluate ? registrationLaunchChooser(input.evaluate, registrationLaunchContextReader({
    ...input, spaceId: placement.spaceId,
  })) : undefined);
  if (result.rejected.length) {
    await new PostgresRuntimeRepository(input.database).recordRoutingRejections({
      channelId: input.channelId, sourceMessageId: input.sourceMessageId, actorUserId: input.actorUserId,
      rejected: result.rejected.map(item => ({ sourceMention: item.sourceMention,
        // Keep the typed domain code so diagnose names the actual cause; only
        // an untyped value collapses to the generic rejection.
        code: REGISTRATION_PREPARATION_REJECTION_CODES.includes(item.code) || /^[a-z][a-z0-9_]{2,79}$/u.test(item.code)
          ? item.code : "registration_launch_rejected" })),
    });
  }
  return { ...result, shardId: placement.shardId, channelId: input.channelId };
}

interface RegistrationInputLaunch {
  runId: string; instanceId: string; launchId: string; agentName: string; hostId: string; reused: boolean;
  /** Channel About sessions that finished their turn and still run; the caller stops them. */
  retiredAboutSessions?: ChannelAboutSessionStopTarget[];
  /** An About session already serves the Channel; nothing was launched. */
  coalesced?: boolean;
}

/** What any-input launch callers state, whichever side of the relay they are on. */
interface RegistrationInputRequest {
  /** Exclude the stable registration bound to this predecessor Instance. */
  excludeSourceInstanceId?: string;
  commandId: string; actorUserId: string; channelId: string; body: string; runMetadata?: Record<string, unknown>;
  runId?: string; instanceId?: string;
  initialMessageId?: string; presentationMessageId?: string; tags?: AutoLaunchTags;
  aboutSession?: RegistrationAboutSession;
  /** Capabilities the work needs; those a daemon can prove gate where it runs. */
  requiredCapabilities?: readonly string[];
}

/** Launch from any input. Jev chooses among every authorized registration in
 * the Channel's Space; no source message is required. */
export async function executeRegistrationInputDispatch(input: RegistrationInputRequest & {
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; evaluate: RoutingEvaluator;
}) {
  const { placement, repository } = await channelLaunchRepository(input);
  const prepared = await repository.dispatchInput(input, registrationLaunchChooser(input.evaluate));
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
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; evaluate: RoutingEvaluator;
  commandId: string; actorUserId: string; channelId: string; messageId: string; body: string;
  /** The author is a Human, who may choose first. */
  window: boolean;
}): Promise<FirstMessageDecision> {
  const { placement, repository } = await channelLaunchRepository(input);
  const choose = registrationLaunchChooser(input.evaluate);
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
}, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
): Promise<FirstMessageDecision> {
  const request = (step: string) => `${input.commandId}:${step}`.slice(0, 200);
  const where = { channelId: input.channelId, messageId: input.messageId };
  const window = await input.choices.open({ requestId: request("open"), ...where, authorUserId: input.actorUserId });
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
  if (value.woken.length > 0) await wakeAgentLaunchCoordinator(env, input.channelId);
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

/** A handoff of a source Instance to a named successor harness, or to the one
 * Jev picks for `auto`; an automatic handoff that went through is handed to
 * the Channel's coordinator before it is answered. */
export async function prepareRegistrationHandoff(env: Env, input: {
  commandId: string; actorUserId: string; channelId: string; sourceMessageId: string;
  sourceInstanceId: string; sourceMention?: string; successorHarness: string; prompt: string;
}): Promise<Record<string, unknown>> {
  const placed = { ...runtimePlacement(env), ...input };
  if (!isAutoHandoffSuccessor(input.successorHarness)) return executeRegistrationHandoffPrepare(placed);
  const result = await executeRegistrationAutoHandoff(placed);
  if (result.outcome === "handed_off") await wakeAgentLaunchCoordinator(env, input.channelId);
  return result;
}

/** Jev decides whether a new conversation's first message asks for an Agent;
 * a Human author may choose first within the window. */
export function decideNewConversationLaunch(env: Env, input: {
  commandId: string; actorUserId: string; channelId: string; messageId: string; body: string; window: boolean;
}) {
  const evaluate = jevEvaluator(env, { actorUserId: input.actorUserId, channelId: input.channelId,
    sourceMessageId: input.commandId, invocationId: input.commandId });
  if (!evaluate) throw new RegistrationAccessError("registration_selection_unconfigured", 503);
  return executeFirstMessageDecision({ ...runtimePlacement(env), evaluate, ...input });
}

/** Hub-side caller for any-input launches; wakes the daemon after the durable prepare. */
export async function dispatchRegistrationInput(input: RegistrationInputRequest & {
  env: Env;
}): Promise<RegistrationInputLaunch> {
  const { env, ...request } = input;
  const evaluate = jevEvaluator(env, { actorUserId: request.actorUserId, channelId: request.channelId,
    sourceMessageId: request.commandId, invocationId: request.commandId });
  if (!evaluate) throw new RegistrationAccessError("registration_selection_unconfigured", 503);
  const result = await executeRegistrationInputDispatch({ ...runtimePlacement(env), evaluate, ...request }) as
    RegistrationInputLaunch & { shardId?: string };
  const retired = result.retiredAboutSessions?.length ? { retiredAboutSessions: result.retiredAboutSessions } : {};
  if (result.coalesced) return { runId: result.runId, instanceId: result.instanceId, launchId: "",
    agentName: result.agentName, hostId: result.hostId, reused: true, coalesced: true, ...retired };
  // The launch is answered only once its Channel's coordinator owns it; the
  // caller's retry of the same command recovers the prepare and wakes again.
  await dispatchPreparedAgentLaunchWake({
    channels: env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL,
    channelId: request.channelId, launchIds: [result.launchId],
    ...(typeof result.shardId === "string" ? { shardId: result.shardId } : {}),
  });
  return { runId: result.runId, instanceId: result.instanceId, launchId: result.launchId,
    agentName: result.agentName, hostId: result.hostId, reused: result.reused, ...retired };
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

/** Handoff: a new Instance of `successorHarness`, registered on the source's
 * owner and machine, takes over the source's retained directory. */
export async function executeRegistrationHandoffPrepare(input: {
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; commandId: string; actorUserId: string;
  channelId: string; sourceMessageId: string; sourceInstanceId: string; sourceMention?: string; successorHarness: string;
  prompt: string;
}) {
  return (await placedRebornRepository(input, "handoff")).prepareHandoff(input);
}

/** `handoff:@auto`: the first other harness on the source's machine with
 * headroom takes its retained directory, or the source's repository is named
 * so a successor can start on any machine. */
export async function executeRegistrationAutoHandoff(input: {
  env?: AppConnectorEnv; database: AuthorityDatabase; directory: AuthorityDatabase; commandId: string; actorUserId: string;
  channelId: string; sourceMessageId: string; sourceInstanceId: string; sourceMention?: string; prompt: string;
}) {
  return (await placedRebornRepository(input, "handoff")).prepareAutoHandoff(input);
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
  commandId: string; forceMention?: string;
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
    evaluate: jevEvaluator(env, { actorUserId: input.actorUserId, channelId: input.channelId,
      sourceMessageId: messageId, invocationId: input.commandId }) });
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
