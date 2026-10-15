import { HANDOFF_BRANCH_PREFIX, sha256Hex } from "@xmatrix/protocol";
import { createProductAgentInterventionAuthorityPort } from "./product-agent-intervention-authority-adapter";
import { dispatchRegistrationInput } from "./registration-launch-dispatch";
import type { Env } from "./types";

/** How long a handoff waits for the source's machine to confirm its stop and
 * push before the successor starts anyway. The push is already commanded and
 * the successor fetches the branch once it appears; a Worker's background
 * work after a response does not outlive ~30 seconds. */
const HANDOFF_STOP_WAIT_MS = 15_000;

/** A handoff: the source stops and a successor starts through the ordinary
 * launch routing, on any machine, exactly as a summon would. */
export interface HandoffSuccessor {
  /** Stable per handoff message, so a replay repeats the same steps and branch. */
  commandId: string;
  actorUserId: string;
  channelId: string;
  sourceMessageId: string;
  sourceRunId: string;
  sourceInstanceId: string;
  /** `@name:<n>` as the Channel addresses the source. */
  sourceAddress: string;
  /** The handoff mention as written, so the message can show what was picked. */
  sourceMention?: string;
  /** The successor's harness; absent for `@auto`, where routing picks any. */
  harness?: string;
  /** The rest of the handoff message, given to the successor as its request. */
  request: string;
  /** Where the source worked; with neither, a private managed directory and
   * the successor starts in a fresh one. A repository's whole checkout
   * travels on a handoff branch. */
  repository?: string;
  /** A directory registered on a machine: routing can only place it there. */
  directory?: string;
}

type Dependencies = {
  dispatch?: typeof dispatchRegistrationInput;
  intervention?: typeof createProductAgentInterventionAuthorityPort;
};

/** One branch per handoff, named from its command so a replay reuses it. */
export async function handoffBranch(commandId: string): Promise<string> {
  return HANDOFF_BRANCH_PREFIX + (await sha256Hex(commandId)).slice(0, 16);
}

/** The assignment of a handoff successor. */
export function handoffSuccessorPrompt(input: { channelId: string; sourceAddress: string; sourceInstanceId: string;
  request: string; repository?: string; branch?: string; directory?: string }): string {
  const site = input.repository && input.branch ? [
    `Predecessor: ${input.sourceAddress} (instance ${input.sourceInstanceId}) in ${input.repository}`,
    "You run in a fresh checkout, possibly on another machine.",
    `Its machine was asked to push its whole checkout, including uncommitted and untracked work, to branch \`${input.branch}\` as it stops.`,
    `Fetch it with \`git fetch origin ${input.branch} && git checkout --detach FETCH_HEAD\`; if the branch is not there yet, retry for a few minutes.`,
    "If its last commit is \"xMatrix handoff: uncommitted work of …\", treat it as work in progress and reshape it into proper commits on your own branch.",
    "If the branch never appears, its directory remains on its machine. Continue from what it already pushed (its branch or pull request, named in the Channel or on the remote); do not redo finished work.",
  ] : input.directory ? [
    `Predecessor: ${input.sourceAddress} (instance ${input.sourceInstanceId}) in ${input.directory}`,
    "You run in the same directory; its files are as the predecessor left them.",
  ] : [
    `Predecessor: ${input.sourceAddress} (instance ${input.sourceInstanceId}) in a private directory`,
    "You run in a fresh directory, possibly on another machine; the predecessor's files stayed on its machine.",
  ];
  return [
    `You were started by an xMatrix handoff: ${input.sourceAddress} handed its work to you.`,
    "This is an explicit assignment. Do not complete silently.",
    ...site,
    `Read the Channel with \`xmatrix channel history ${input.channelId}\` and continue the predecessor's unfinished work.`,
    `Channel-visible replies require an explicit send. Before completing, you MUST use the shell to run \`xmatrix send ${input.channelId} "<message>"\`.`,
    "Local stdout is not a reply.",
    ...(input.request.trim() ? ["", "Source Channel message:", input.request.trim()] : []),
  ].join("\n");
}

/**
 * Move a source's work to a successor. Its daemon stops it (a repository
 * checkout is pushed whole, uncommitted and untracked changes included, to a
 * handoff branch); then a new Instance starts through the ordinary any-input
 * launch, constrained only by the work site and a named harness, so routing
 * weighs every registration with quota on every machine, as for any summon.
 * Only the source's own registration is excluded.
 */
export async function launchHandoffSuccessor(env: Env, input: HandoffSuccessor,
  dependencies: Dependencies = {}): Promise<{ agentName: string }> {
  const { repository, directory } = input;
  const branch = repository ? await handoffBranch(input.commandId) : undefined;
  await stopSource(env, input, branch, dependencies);
  const site = repository && branch ? { repository, branch } : directory ? { directory } : {};
  // Stop/export observations change as the source exits. Keep the launch
  // request identical so a retry recovers a staged successor after a lost wake.
  const launched = await (dependencies.dispatch ?? dispatchRegistrationInput)({
    env, commandId: input.commandId, actorUserId: input.actorUserId, channelId: input.channelId,
    body: handoffSuccessorPrompt({ channelId: input.channelId, sourceAddress: input.sourceAddress,
      sourceInstanceId: input.sourceInstanceId, request: input.request, ...site }),
    tags: { ...(repository ? { repo: repository } : directory ? { pwd: directory } : {}),
      ...(input.harness ? { harness: input.harness } : {}) },
    excludeSourceInstanceId: input.sourceInstanceId,
    // The pick is a registration launch, not a continuation. Drawing it on the
    // handoff message is what lets `@auto` show the parameters Jev chose.
    presentationMessageId: input.sourceMessageId,
    ...(input.sourceMention ? { runMetadata: { sourceMention: input.sourceMention } } : {}),
  });
  return { agentName: launched.agentName };
}

/** Stop the source; with a branch its daemon pushes its checkout. The
 * directory stays. */
async function stopSource(env: Env, input: HandoffSuccessor, branch: string | undefined,
  dependencies: Dependencies): Promise<void> {
  const port = (dependencies.intervention ?? createProductAgentInterventionAuthorityPort)({
    env, actorUserId: input.actorUserId, sourceMessageId: input.sourceMessageId });
  const target = (await port.listKillTargets(input.channelId, {
    runId: input.sourceRunId, instanceId: input.sourceInstanceId,
  })).find(candidate => candidate.runId === input.sourceRunId && candidate.instanceId === input.sourceInstanceId);
  if (!target || !port.issueHandoffStop) throw Object.assign(new Error("Handoff source stop is unavailable"), {
    code: "handoff_source_stop_unavailable",
  });
  // A timeout follows a durable stop request. An authority/issuance failure
  // must surface instead of starting a successor while the source can still act.
  await port.issueHandoffStop(target, `handoff-stop:${input.sourceRunId}`.slice(0, 200),
    `${input.sourceAddress} handed off`, input.channelId,
    branch ? { branch, channelId: input.channelId } : undefined, HANDOFF_STOP_WAIT_MS);
}
