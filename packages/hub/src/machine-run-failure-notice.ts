import { publicMachineStartupFailure, sha256Hex, type RepositoryBaseline } from "@xmatrix/protocol";
import { appendChannelMessage } from "./channel-messages";
import { recordCommandResult } from "./command-result";
import { humanizeMachineRunFailureDetail, machineStopFailureCode } from "./machine-run-failure";
import { XMATRIX_SYSTEM_AVATAR_URL, XMATRIX_SYSTEM_LABEL } from "./xmatrix-system-identity";
import type { Env } from "./types";

export interface MachineRunFailureNotice {
  runId: string; channelId: string; agentName: string; detail: string; phase?: string;
  /** The Agent's harness, which gives the notice its face (protocol faces.ts). */
  harness?: string;
  /** The summon that started the Run: the failure answers on its chip. */
  sourceMessageId?: string;
  ownerUserId: string; ownerEmail: string; machineId: string; hostId: string;
  /** The owner's name for the Machine; the notice names nothing else. */
  machineName?: string;
}

/** " on <Machine>" as its owner named it. A hostname is an observation and
 * never names a Machine, so a notice without the name names no machine. */
function onMachine(input: { machineName?: string }): string {
  const name = input.machineName?.trim();
  return name ? ` on ${name}` : "";
}

/** A Machine notice is written under its owner's authority and shown as xMatrix. */
function systemNoticeAuthor(input: { ownerUserId: string; ownerEmail: string }) {
  return { principal: { kind: "user", id: input.ownerUserId },
    senderSnapshot: { identityId: `user:${input.ownerUserId}`, kind: "user", userId: input.ownerUserId,
      email: input.ownerEmail, label: XMATRIX_SYSTEM_LABEL, name: XMATRIX_SYSTEM_LABEL,
      avatarUrl: XMATRIX_SYSTEM_AVATAR_URL } };
}

/** Stable per-Run key: a replay retries the append, never adds another notice. */
export async function machineRunFailureNoticeCommand(input: MachineRunFailureNotice) {
  const digest = await sha256Hex(input.runId);
  const detail = String(input.detail || "").trim() || "Unknown startup failure";
  const humanized = humanizeMachineRunFailureDetail(detail);
  return {
    commandId: `machine-run-failure-notice:${digest}`.slice(0, 200),
    messageId: `system:machine-run-failure:${digest}`.slice(0, 200), channelId: input.channelId,
    body: [`Couldn't start @${input.agentName}${onMachine(input)}${input.phase ? ` during ${input.phase}` : ""}.`,
      "", humanized.summary, ...(humanized.action ? ["", humanized.action] : [])].join("\n"),
    messageKind: "xmatrix.system.runtime-failure", ...systemNoticeAuthor(input),
    residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      source: "machine_run_failure", runId: input.runId, machineId: input.machineId, machineOwnerUserId: input.ownerUserId, machineName: input.machineName,
      failureCode: humanized.code, failureDetail: humanized.summary,
      ...(input.harness ? { harness: input.harness } : {}),
      ...(input.phase ? { statusPhase: input.phase } : {}) } },
  };
}

export async function publishMachineRunFailureNotice(env: Env, input: MachineRunFailureNotice): Promise<void> {
  await deliverMachineNotice(env, await machineRunFailureNoticeCommand(input), input, "startup-failure");
}

/**
 * A Machine fact about a Run a message asked for answers on that message's
 * chip, recorded on the message, never posted as another one. A Run nothing in
 * the Channel asked for (a stop from elsewhere, an Automation) still says it
 * as a notice, because nothing else would.
 */
async function deliverMachineNotice(env: Env, command: Record<string, unknown> & { channelId: string; body: string },
  input: { runId: string; sourceMessageId?: string }, key: string): Promise<void> {
  if (!input.sourceMessageId) {
    await appendChannelMessage(env, command.channelId, command);
    return;
  }
  await recordCommandResult(env, { channelId: command.channelId, messageId: input.sourceMessageId,
    key: `${key}:${input.runId}`, entry: { note: { text: command.body, runId: input.runId } } });
}

/** The same message went to another Agent after a failed start. Stable per
 * failed Run, so a replay never adds a second line. */
export async function startupFallbackNoticeCommand(input: {
  runId: string; channelId: string; agentName: string; ownerUserId: string; ownerEmail: string;
}) {
  const digest = await sha256Hex(input.runId);
  return {
    commandId: `startup-fallback-notice:${digest}`.slice(0, 200),
    messageId: `system:startup-fallback:${digest}`.slice(0, 200), channelId: input.channelId,
    body: `@${input.agentName} is taking this message instead.`,
    messageKind: "xmatrix.system.runtime-failure", ...systemNoticeAuthor(input),
    residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      source: "startup_fallback", runId: input.runId } },
  };
}

export async function publishStartupFallbackNotice(env: Env,
  input: Parameters<typeof startupFallbackNoticeCommand>[0] & { sourceMessageId?: string }): Promise<void> {
  await deliverMachineNotice(env, await startupFallbackNoticeCommand(input), input, "startup-fallback");
}

export interface MachineStopResultNotice {
  runId: string; controlKey: string; channelId: string; agentName: string; ok: boolean; detail?: string;
  ownerUserId: string; ownerEmail: string; machineId: string; hostId: string;
  machineName?: string;
  startupFailed?: boolean;
  /** The stop command that asked for this stop: the result answers on its chip. */
  sourceMessageId?: string;
}

/** Stable per stop and outcome. The daemon's error passes the same boundary
 * redaction as a startup failure (credentials, URL secrets, local paths), so
 * the notice shows the originating error rather than pointing at a log. */
export async function machineStopResultNoticeCommand(input: MachineStopResultNotice) {
  const outcome = input.ok ? "completed" : "failed";
  const digest = await sha256Hex(`${input.controlKey}\0${outcome}`);
  const body = input.ok
    ? input.startupFailed
      ? `Startup failed for @${input.agentName}${onMachine(input)}. Cleanup confirmed no process remains. See the startup failure notice or invocation details for the cause.`
      : `Stopped @${input.agentName}${onMachine(input)}. The Workstation confirmed the process tree is terminated.`
    : [`Couldn't stop @${input.agentName}${onMachine(input)}.`, "",
      publicMachineStartupFailure(input.detail)?.summary ?? "The Workstation reported the stop failed without an error.", "",
      "The process may still be running. Retry the stop."].join("\n");
  return {
    commandId: `machine-stop-result-notice:${digest}`.slice(0, 200),
    messageId: `system:machine-stop-result:${digest}`.slice(0, 200), channelId: input.channelId, body,
    messageKind: "xmatrix.system.stop-result", ...systemNoticeAuthor(input),
    residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      source: "machine_stop_result", runId: input.runId, machineId: input.machineId, machineOwnerUserId: input.ownerUserId, machineName: input.machineName,
      stopOutcome: outcome, ...(input.startupFailed ? { startupFailed: true } : {}),
      ...(input.ok ? {} : { stopFailureCode: machineStopFailureCode(String(input.detail || "").trim()) }) } },
  };
}

export async function publishMachineStopResultNotice(env: Env, input: MachineStopResultNotice): Promise<void> {
  await deliverMachineNotice(env, await machineStopResultNoticeCommand(input), input, "stop-result");
}

/** Once per checkout/base in this Channel, including report replays and later
 * reborns. Only immutable base facts enter the command; remote tips change. */
export async function repositoryBaselineNoticeCommand(input: {
  channelId: string; ownerUserId: string; ownerEmail: string; baseline: RepositoryBaseline;
}) {
  if (input.baseline.relationship !== "diverged" || !input.baseline.noticeKey || !input.baseline.remote) {
    throw new TypeError("A repository continuity notice requires proven divergence");
  }
  const digest = await sha256Hex(`${input.channelId}\0${input.baseline.noticeKey}`);
  return {
    commandId: `repository-baseline-notice:${digest}`, messageId: `system:repository-baseline:${digest}`,
    channelId: input.channelId, ...systemNoticeAuthor(input), messageKind: "xmatrix.system.repository-continuity",
    body: `This continued task's recorded base ${input.baseline.baseRef} @ ${input.baseline.baseOid} is no longer an ancestor of the confirmed remote default branch. The checkout and uncommitted work have been preserved. Before publishing, check the current remote history and avoid reintroducing removed commits.`,
    residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      source: "repository_baseline", noticeKey: input.baseline.noticeKey,
      baseRef: input.baseline.baseRef, baseOid: input.baseline.baseOid } },
  };
}

export async function publishRepositoryBaselineNotice(env: Env, input: Parameters<typeof repositoryBaselineNoticeCommand>[0]): Promise<void> {
  await appendChannelMessage(env, input.channelId, await repositoryBaselineNoticeCommand(input));
}
