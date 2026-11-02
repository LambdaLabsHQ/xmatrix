import { ControlError } from "@xmatrix/db";
import {
  CONNECTOR_RECEIPT_FIXES_KEY, connectorReceiptFixesOf, plainRecord, SETTINGS_REQUEST_KEY, settingAddress, settingAddressFix,
  settingsCardOf,
  type SettingDescriptor, type SettingsCardEntry,
} from "@xmatrix/protocol";
import { channelMessageHistory } from "./channel-messages";
import { postgresMessageExists, withPostgresMessageRequestScope } from "./postgres-message-authority";
import { REQUESTER_INSTANCE_KEY } from "./connector-message-delivery";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { SettingsAsker } from "./settings-registry";
import type { Env } from "./types";

/** The card an Agent posts to ask for settings (`xmatrix settings ask`). */
export const SETTINGS_REQUEST_MESSAGE_KIND = "xmatrix.system.settings-request";
/** xMatrix's answer under a card once every setting on it is in. */
export const SETTINGS_READY_MESSAGE_KIND = "xmatrix.system.settings-ready";

/** Who asked, as the Hub wrote it on its own card: the Run's owner, the Run, its Channel and its Instance. */
export interface SettingsCardAsker extends SettingsAsker {
  agentName: string;
  instanceId?: string;
}

/** A card the Hub wrote that asks for settings: an Agent's request, or a stopped command's receipt. */
export interface SettingsCardRead {
  channelId: string;
  messageId: string;
  sentAt: string;
  entries: SettingsCardEntry[];
  asker?: SettingsCardAsker;
  /** A stopped read that runs again once its setting is in. */
  resumeExecutionId?: string;
}

/** The people a card's settings wait on, in words: the writers its descriptors name. */
function askedOf(descriptors: readonly SettingDescriptor[]): string {
  const writers = new Set(descriptors.map((descriptor) => descriptor.writer));
  return writers.size > 1 ? "the people who can make them" : writers.has("machine-owner") ? "the Machine's owner" : "a Space admin";
}

/** One setting in a sentence, worded by its control, never by its domain. */
export function settingPhrase(descriptor: SettingDescriptor): string {
  switch (descriptor.control) {
    case "sign-in": case "harness-sign-in": return `sign in to ${descriptor.scope.replace(/^Sign in to /u, "")}`;
    case "connect": return `connect ${descriptor.scope}`;
    case "grant": return descriptor.label;
    default: return `${descriptor.scope} ${descriptor.label}`;
  }
}

/**
 * The English text CLI readers, Agents and clients without the card read for
 * it. Each setting links where it lives, so a client that cannot draw the
 * card still takes a person there.
 */
export function settingsCardBody(agentName: string, descriptors: readonly SettingDescriptor[], reason?: string): string {
  const asked = descriptors.map((descriptor) => descriptor.href ? `[${settingPhrase(descriptor)}](${descriptor.href})` : settingPhrase(descriptor));
  return `**${agentName || "An Agent"}** asks ${askedOf(descriptors)} for ${asked.join(", ")}` +
    `${reason ? `: ${reason}` : "."}\n\nThey make it on this card; a value goes where the setting lives, never into chat.`;
}

/** The trusted metadata of the card an Agent posts; connector entries also keep the older fixes key. */
export function settingsCardMetadata(asker: SettingsCardAsker, entries: readonly SettingsCardEntry[],
  extra: { reason?: string; requestId?: string }) {
  const fixes = entries.flatMap((entry) => {
    const fix = settingAddressFix(entry.address);
    return fix ? [{ ...fix, ...(entry.proposed ? { proposed: entry.proposed } : {}) }] : [];
  });
  return {
    [SETTINGS_REQUEST_KEY]: { agentName: asker.agentName, ...(extra.reason ? { reason: extra.reason } : {}),
      // The caller's id makes a retry replay its card and a later request a new one.
      ...(extra.requestId ? { requestId: extra.requestId } : {}),
      settings: entries, askedBy: { userId: asker.userId, ...(asker.runId ? { runId: asker.runId } : {}),
        ...(asker.channelId ? { channelId: asker.channelId } : {}), ...(asker.instanceId ? { instanceId: asker.instanceId } : {}) } },
    ...(fixes.length ? { [CONNECTOR_RECEIPT_FIXES_KEY]: fixes } : {}),
  };
}

/** Appends a card the Hub writes and delivers it live, as every message the Hub writes is delivered. */
export async function appendHubCard(env: Env, channelId: string, append: Record<string, unknown>): Promise<void> {
  const response = await dispatchProductMessageAppend(env, channelId, append);
  if (response.ok) return;
  const answer = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown; retryable?: unknown };
  throw new ControlError(typeof answer.code === "string" ? answer.code : "card_append_failed", response.status,
    typeof answer.error === "string" ? answer.error : "The card could not be posted", answer.retryable === true);
}

function askerOf(value: unknown): SettingsCardAsker | undefined {
  const row = plainRecord(value), request = plainRecord(row?.askedBy);
  const text = (field: unknown) => typeof field === "string" && field.trim() && field.length <= 300 ? field : undefined;
  const userId = text(request?.userId);
  if (!userId) return undefined;
  const runId = text(request?.runId), channelId = text(request?.channelId), instanceId = text(request?.instanceId);
  return { userId, agentName: text(row?.agentName) ?? "", ...(runId ? { runId } : {}), ...(channelId ? { channelId } : {}),
    ...(instanceId ? { instanceId } : {}) };
}

/**
 * The settings card at `sequence` in a Channel, as `viewerUserId` may read it,
 * only from a message the Hub wrote: its `xmatrix*` keys are ones no caller
 * can set. Undefined for any other message.
 */
export async function readSettingsCard(env: Env, input: { channelId: string; messageId: string; sequence: number;
  viewerUserId: string }): Promise<SettingsCardRead | undefined> {
  const history = await channelMessageHistory(env, { channelId: input.channelId, afterSequence: input.sequence - 1, limit: 1,
    principal: { kind: "user", id: input.viewerUserId } });
  const message = (Array.isArray(history.messages) ? history.messages : []).map(plainRecord)
    .find((candidate) => candidate?.messageId === input.messageId && candidate.sequence === input.sequence);
  const metadata = plainRecord(plainRecord(message?.messageResidual)?.appMetadata);
  if (!message || metadata?.xmatrixProvenance !== "system_fact" || typeof message.sentAt !== "string") return undefined;
  const card = settingsCardOf(metadata);
  const base = { channelId: input.channelId, messageId: input.messageId, sentAt: message.sentAt };
  if (card) {
    const asker = askerOf(metadata[SETTINGS_REQUEST_KEY]);
    return { ...base, entries: card.settings, ...(asker ? { asker } : {}) };
  }
  // A stopped command's receipt: each fix's setting, and the read to run again.
  const fixes = connectorReceiptFixesOf(metadata);
  if (!fixes.length) return undefined;
  return { ...base, entries: fixes.map((fix) => ({ address: settingAddress(fix) })),
    ...(fixes[0]!.executionId ? { resumeExecutionId: fixes[0]!.executionId } : {}) };
}

/**
 * Once every setting on an Agent's card is in, xMatrix answers the card once:
 * the answer wakes the Instance that asked, and that is the only way it
 * learns. The answer's id is the card's, so any number of evaluations post it
 * once. A receipt needs none: its read runs again and that receipt wakes it.
 */
export async function answerSettingsCard(env: Env, card: SettingsCardRead, descriptors: readonly SettingDescriptor[]):
  Promise<string | undefined> {
  if (!card.asker?.instanceId || !descriptors.length || !descriptors.every((descriptor) => descriptor.satisfied)) return undefined;
  const messageId = `settings-ready:${card.messageId}`.slice(0, 200);
  // The card is read again while it is open; a replayed answer would deliver, and wake, once more.
  if (await withPostgresMessageRequestScope(env, (scope) => postgresMessageExists(env, { channelId: card.channelId, messageId,
    principal: { kind: "user", id: card.asker!.userId } }, scope))) return messageId;
  const done = descriptors.map((descriptor) => `\`${descriptor.address}\``).join(", ");
  await appendHubCard(env, card.channelId, {
    commandId: `product:${messageId}`.slice(0, 200), messageId, channelId: card.channelId,
    body: `**${card.asker.agentName || "The Agent"}**, the settings you asked for are in: ${done}. Go on with what needed them.`,
    messageKind: SETTINGS_READY_MESSAGE_KIND, principal: { kind: "user", id: card.asker.userId }, xmatrixAuthor: true,
    residual: { replyToMessageId: card.messageId, appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      [REQUESTER_INSTANCE_KEY]: card.asker.instanceId,
      xmatrixSettingsReady: { cardMessageId: card.messageId, settings: descriptors.map((descriptor) => descriptor.address) } } },
  });
  return messageId;
}
