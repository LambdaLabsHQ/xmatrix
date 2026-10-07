import { sha256Hex } from "@xmatrix/protocol";
import { appendChannelMessage } from "./channel-messages";
import { humanizeMachineRunFailureDetail, machineStopFailureCode } from "./machine-run-failure";
import { XMATRIX_MANAGEMENT_AVATAR_URL, XMATRIX_MANAGEMENT_LABEL } from "./management-identity";
import type { Env } from "./types";

export interface MachineRunFailureNotice {
  runId: string; channelId: string; agentName: string; detail: string; phase?: string;
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
      email: input.ownerEmail, label: XMATRIX_MANAGEMENT_LABEL, name: XMATRIX_MANAGEMENT_LABEL,
      avatarUrl: XMATRIX_MANAGEMENT_AVATAR_URL } };
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
      ...(input.phase ? { statusPhase: input.phase } : {}) } },
  };
}

export async function publishMachineRunFailureNotice(env: Env, input: MachineRunFailureNotice): Promise<void> {
  await appendChannelMessage(env, input.channelId, await machineRunFailureNoticeCommand(input));
}

export interface MachineStopResultNotice {
  runId: string; controlKey: string; channelId: string; agentName: string; ok: boolean; detail?: string;
  ownerUserId: string; ownerEmail: string; machineId: string; hostId: string;
  machineName?: string;
  startupFailed?: boolean;
}

/** Stable per stop and outcome. The raw daemon error can carry host paths,
 * command lines or usernames, and Channel history (body and metadata) reaches
 * every member, so only a stable classification code ships; the detail stays
 * in the daemon's local audit log, which the body points at. */
export async function machineStopResultNoticeCommand(input: MachineStopResultNotice) {
  const outcome = input.ok ? "completed" : "failed";
  const digest = await sha256Hex(`${input.controlKey}\0${outcome}`);
  const body = input.ok
    ? input.startupFailed
      ? `Startup failed for @${input.agentName}${onMachine(input)}. Cleanup confirmed no process remains. See the startup failure notice or invocation details for the cause.`
      : `Stopped @${input.agentName}${onMachine(input)}. The Workstation confirmed the process tree is terminated.`
    : [`Couldn't stop @${input.agentName}${onMachine(input)}.`, "",
      "The Workstation reported the stop failed, so the process may still be running.", "",
      "Retry the stop, or check that machine's daemon logs for details."].join("\n");
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
  await appendChannelMessage(env, input.channelId, await machineStopResultNoticeCommand(input));
}
