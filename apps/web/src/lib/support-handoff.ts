"use client";

import { useSyncExternalStore } from "react";
import {
  parseSupportHandoffRequest, WEB_PROXY_ROUTES,
  type SupportDiagnosticEvent, type SupportHandoff, type SupportHandoffPart, type SupportHandoffRequest,
} from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";

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
