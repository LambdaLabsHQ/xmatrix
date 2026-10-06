import { HANDOFF_BRANCH_PREFIX, sha256Hex } from "@xmatrix/protocol";
import { createProductAgentInterventionAuthorityPort } from "./product-agent-intervention-authority-adapter";
import { dispatchRegistrationInput } from "./registration-launch-dispatch";
import type { Env } from "./types";

/** How long a handoff waits for the source's machine to confirm its stop and
 * push before the successor starts anyway. The push is already commanded and
 * the successor fetches the branch once it appears; a Worker's background
 * work after a response does not outlive ~30 seconds. */
const HANDOFF_STOP_WAIT_MS = 15_000;

/** A handoff whose successor starts from a fresh checkout, on any machine. */
export interface HandoffElsewhere {
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
  /** The source's repository; the successor starts from a fresh checkout of it. */
  repository: string;
  /** The successor's harness; absent for `@auto`, where routing picks any. */
  harness?: string;
  /** The rest of the handoff message, given to the successor as its request. */
  request: string;
}

type Dependencies = {
  dispatch?: typeof dispatchRegistrationInput;
  intervention?: typeof createProductAgentInterventionAuthorityPort;
};

/** One branch per handoff, named from its command so a replay reuses it. */
export async function handoffBranch(commandId: string): Promise<string> {
  return HANDOFF_BRANCH_PREFIX + (await sha256Hex(commandId)).slice(0, 16);
}

/** The assignment of a successor started in a fresh checkout. */
export function handoffElsewherePrompt(input: { channelId: string; sourceAddress: string; sourceInstanceId: string;
  repository: string; branch: string; request: string }): string {
  return [
    `You were started by an xMatrix handoff: ${input.sourceAddress} handed its work to you.`,
    "This is an explicit assignment. Do not complete silently.",
    `Predecessor: ${input.sourceAddress} (instance ${input.sourceInstanceId}) in ${input.repository}`,
    "You run in a fresh checkout, possibly on another machine.",
    `Its machine was asked to push its whole checkout, including uncommitted and untracked work, to branch \`${input.branch}\` as it stops.`,
    `Fetch it with \`git fetch origin ${input.branch} && git checkout --detach FETCH_HEAD\`; if the branch is not there yet, retry for a few minutes.`,
    "If its last commit is \"xMatrix handoff: uncommitted work of …\", treat it as work in progress and reshape it into proper commits on your own branch.",
    "If the branch never appears, its directory remains on its machine. Continue from what it already pushed (its branch or pull request, named in the Channel or on the remote); do not redo finished work.",
    `Read the Channel with \`xmatrix channel history ${input.channelId}\` and continue the predecessor's unfinished work.`,
    `Channel-visible replies require an explicit send. Before completing, you MUST use the shell to run \`xmatrix send ${input.channelId} "<message>"\`.`,
    "Local stdout is not a reply.",
    ...(input.request.trim() ? ["", "Source Channel message:", input.request.trim()] : []),
  ].join("\n");
}

/**
 * Move a source's work to a successor that may run on any machine. Its daemon
 * stops it and pushes its whole checkout, uncommitted and untracked changes
 * included, to a handoff branch; then a new Instance starts through the
 * ordinary any-input launch, pinned to the repository (and the named harness),
 * so routing picks any registration with quota on any machine except the
 * source's own, and is told to continue from that branch.
 */
export async function launchHandoffSuccessorElsewhere(env: Env, input: HandoffElsewhere,
  dependencies: Dependencies = {}): Promise<{ agentName: string }> {
  const branch = await handoffBranch(input.commandId);
  await saveSourceWork(env, input, branch, dependencies);
  // Stop/export observations change as the source exits. Keep the launch
  // request identical so a retry recovers a staged successor after a lost wake.
  const launched = await (dependencies.dispatch ?? dispatchRegistrationInput)({
    env, commandId: input.commandId, actorUserId: input.actorUserId, channelId: input.channelId,
    body: handoffElsewherePrompt({ channelId: input.channelId, sourceAddress: input.sourceAddress,
      sourceInstanceId: input.sourceInstanceId, repository: input.repository, branch, request: input.request }),
    tags: { repo: input.repository, ...(input.harness ? { harness: input.harness } : {}) },
    excludeSourceInstanceId: input.sourceInstanceId,
    // The pick is a registration launch, not a continuation. Drawing it on the
    // handoff message is what lets `@auto` show the parameters Jev chose.
    presentationMessageId: input.sourceMessageId,
    ...(input.sourceMention ? { runMetadata: { sourceMention: input.sourceMention } } : {}),
  });
  return { agentName: launched.agentName };
}

/** Stop the source so its daemon pushes its checkout; the directory stays. */
async function saveSourceWork(env: Env, input: HandoffElsewhere, branch: string,
  dependencies: Dependencies): Promise<void> {
  try {
    const port = (dependencies.intervention ?? createProductAgentInterventionAuthorityPort)({
      env, actorUserId: input.actorUserId, sourceMessageId: input.sourceMessageId });
    const target = (await port.listKillTargets(input.channelId)).find(candidate =>
      candidate.runId === input.sourceRunId && candidate.instanceId === input.sourceInstanceId);
    if (!target || !port.issueHandoffStop) return;
    await port.issueHandoffStop(target, `handoff-stop:${input.sourceInstanceId}`.slice(0, 200),
      `${input.sourceAddress} handed off`, input.channelId, { branch, channelId: input.channelId }, HANDOFF_STOP_WAIT_MS);
  } catch (error) {
    console.error("Handoff source could not be stopped", error);
  }
}
