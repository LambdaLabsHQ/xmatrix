"use client";

import { useSyncExternalStore } from "react";
import {
  parseSupportHandoffRequest, WEB_PROXY_ROUTES,
  type LogExcerptStatus, type SerializedMachineDaemon, type SupportDiagnosticEvent, type SupportHandoff,
  type SupportHandoffPart, type SupportHandoffRequest,
} from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { UserFacingProblem } from "@/lib/user-facing-error";

/**
 * Hand to xMatrix support (docs/cross-space-read-grants.md#support-handoffs).
 * One dialog serves every entry point: a conversation's menu, xMatrix's
 * failure notices and Help's "Report a problem". Each asks for it here with
 * the conversation it is about.
 */

export interface SupportHandoffTarget {
  channelId: string;
  /** The conversation's name as the person sees it. */
  channelName?: string;
}

let target: SupportHandoffTarget | null = null;
const listeners = new Set<() => void>();

function publish(next: SupportHandoffTarget | null) {
  target = next;
  for (const listener of listeners) listener();
}

export function openSupportHandoff(next: SupportHandoffTarget): void {
  publish(next);
}

export function closeSupportHandoff(): void {
  publish(null);
}

export function useSupportHandoffTarget(): SupportHandoffTarget | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => target, () => null);
}

/** What the dialog holds: a line, the parts ticked, and the agreement. Nothing is ticked at first. */
export interface SupportHandoffDraft {
  line: string;
  parts: Record<SupportHandoffPart, boolean>;
  consent: boolean;
  /** The redacted daemon log tail the person previewed, when they ticked logs. */
  logExcerpt?: string;
}

export function emptySupportHandoffDraft(): SupportHandoffDraft {
  return { line: "", parts: { messages: false, diagnostics: false, logs: false }, consent: false };
}

/**
 * The request the draft sends, or nothing while it may not be sent: without
 * the agreement, without a line, or with logs ticked but not yet previewed.
 */
export function supportHandoffRequestOf(draft: SupportHandoffDraft): SupportHandoffRequest | undefined {
  const parts = (Object.keys(draft.parts) as SupportHandoffPart[]).filter((part) => draft.parts[part]);
  return parseSupportHandoffRequest({ line: draft.line, parts, consent: draft.consent,
    ...(draft.parts.logs && draft.logExcerpt !== undefined ? { logExcerpt: draft.logExcerpt } : {}) });
}

/** One of the person's online Machines whose daemon log they can preview. */
export interface SupportLogMachine { machineId: string; label: string }

/**
 * The person's online Machines, one entry per Machine, by the name they gave
 * it. Only the Machine's owner may ask for its logs; the Hub refuses anyone
 * else, so this list is a convenience, not the authority.
 */
export function supportLogMachines(daemons: readonly SerializedMachineDaemon[]): SupportLogMachine[] {
  const machines = new Map<string, SupportLogMachine>();
  for (const daemon of daemons) {
    if (daemon.status !== "online" || !daemon.machineId || machines.has(daemon.machineId)) continue;
    machines.set(daemon.machineId, { machineId: daemon.machineId,
      label: daemon.machineName || daemon.hostName || daemon.hostname || daemon.name });
  }
  return [...machines.values()];
}

const LOG_EXCERPT_POLL_MS = 1_500;
const LOG_EXCERPT_WAIT_MS = 90_000;

/**
 * Ask one of the person's Machines for its redacted daemon log tail and wait
 * for the answer. The daemon redacts it before it leaves the machine; nothing
 * is sent to support until the person sends the handoff with it.
 */
export async function readSupportLogExcerpt(token: string, machineId: string, signal: AbortSignal): Promise<string> {
  const { controlId } = await xmatrixApiRequest<{ controlId: string }>({ url: WEB_PROXY_ROUTES.machine_log_excerpts,
    token, method: "POST", body: { machineId }, signal });
  for (const started = Date.now(); Date.now() - started < LOG_EXCERPT_WAIT_MS;) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, LOG_EXCERPT_POLL_MS);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    const status = await xmatrixApiRequest<LogExcerptStatus>({ url: WEB_PROXY_ROUTES.machine_log_excerpt(controlId),
      token, signal });
    if (status.status === "succeeded" && status.excerpt) return status.excerpt;
    if (status.status === "failed" || status.status === "expired") {
      throw new UserFacingProblem(status.error ?? "The machine could not read its logs", true);
    }
  }
  throw new UserFacingProblem("The machine did not answer in time", true);
}

export function sendSupportHandoff(token: string, channelId: string, request: SupportHandoffRequest) {
  return xmatrixApiRequest<{ handoff: SupportHandoff }>({ url: WEB_PROXY_ROUTES.channel_support_handoffs(channelId),
    token, method: "POST", body: request });
}

export function readSupportHandoff(token: string, spaceId: string, grantId: string, signal?: AbortSignal) {
  return xmatrixApiRequest<{ handoff: SupportHandoff & { viewerRole: "owner" | "admin" | "support" } }>({
    url: WEB_PROXY_ROUTES.support_handoff(spaceId, grantId), token, ...(signal ? { signal } : {}) });
}

export interface SupportHandoffPartRead {
  handoff: SupportHandoff;
  history?: { messages?: Array<{ messageId?: string; sequence?: number; body?: string; sentAt?: string;
    senderSnapshot?: { name?: string } }> };
  diagnostics?: SupportDiagnosticEvent[];
  logExcerpt?: string;
}

export function readSupportHandoffPart(token: string, spaceId: string, grantId: string, part: SupportHandoffPart) {
  return xmatrixApiRequest<SupportHandoffPartRead>({
    url: WEB_PROXY_ROUTES.support_handoff_part(spaceId, grantId, part), token });
}

export function revokeSupportHandoff(token: string, spaceId: string, grantId: string) {
  return xmatrixApiRequest<{ handoff: SupportHandoff }>({ url: WEB_PROXY_ROUTES.support_handoff_revoke(spaceId, grantId),
    token, method: "POST", body: {} });
}

export function replyToSupportHandoff(token: string, spaceId: string, grantId: string, body: string) {
  return xmatrixApiRequest<{ messageId: string }>({ url: WEB_PROXY_ROUTES.support_handoff_replies(spaceId, grantId),
    token, method: "POST", body: { body } });
}

/** The handoff a Hub-written card names, or null for any other message. */
export function supportHandoffCardOf(metadata: Record<string, unknown> | undefined):
  { grantId: string; spaceId: string; channelId?: string; parts: SupportHandoffPart[]; expiresAt?: string;
    from?: { name?: string; email?: string } } | null {
  const value = metadata?.supportHandoff;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === "string" && field.trim() ? field : undefined;
  const grantId = text(record.grantId), spaceId = text(record.spaceId);
  if (!grantId || !spaceId) return null;
  const parts = Array.isArray(record.parts)
    ? record.parts.filter((part): part is SupportHandoffPart => part === "messages" || part === "diagnostics" || part === "logs")
    : [];
  const from = record.from && typeof record.from === "object" ? record.from as Record<string, unknown> : undefined;
  return { grantId, spaceId, parts, channelId: text(record.channelId), expiresAt: text(record.expiresAt),
    ...(from ? { from: { name: text(from.name), email: text(from.email) } } : {}) };
}

/**
 * Whether a Hub-written notice reports xMatrix failing the person: a start
 * that failed, a turn that failed or is being retried, or one with no progress.
 * Those notices offer the handoff.
 */
export function isSupportableFailureNotice(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return ["machine_run_failure", "startup_fallback", "turn_stalled"].includes(String(metadata.source)) ||
    metadata.xmatrixTurnFailure === true || Boolean(metadata.xmatrixTurnRetry);
}
