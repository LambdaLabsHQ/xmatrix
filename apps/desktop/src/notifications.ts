// Pure, platform-agnostic helpers for the desktop notification + dock badge
// behavior. Kept free of Electron imports so they can be unit tested under
// plain Node (see notifications.test.cjs) and reused by main.ts.

import type { DesktopBadgeState, DesktopNotification } from "@xmatrix/protocol";
export type { DesktopBadgeState } from "@xmatrix/protocol";
export type DesktopNotificationPayload = Partial<DesktopNotification>;

export type NotificationPlan = {
  /** Whether the notification has enough content to be shown at all. */
  show: boolean;
  /** Electron NotificationConstructorOptions, only meaningful when show is true. */
  options: {
    title: string;
    body?: string;
    silent?: boolean;
    hasReply: boolean;
    replyPlaceholder?: string;
  };
  /** Whether an inline reply can be sent (channel messages on macOS). */
  canReply: boolean;
  /** Trimmed channel id the reply should be routed to. */
  channelId: string;
};

/**
 * Slack-style dock badge text:
 * - a number for unread mentions/attention (capped at "99+"),
 * - a dot for unread activity without a mention,
 * - empty string once everything is read.
 */
export function dockBadgeText(state: DesktopBadgeState): string {
  const mentionCount = Number.isFinite(state.mentionCount)
    ? Math.max(0, Math.floor(state.mentionCount))
    : 0;
  if (mentionCount > 0) {
    return mentionCount > 99 ? "99+" : String(mentionCount);
  }
  return state.hasUnread ? "•" : "";
}

/**
 * Builds the Electron notification options for a payload, mirroring Slack's
 * toast: channel title, "sender: message" body, and an inline reply
 * field for channel messages on macOS.
 */
export function planNotification(
  payload: DesktopNotificationPayload,
  platform: NodeJS.Platform | string = process.platform
): NotificationPlan {
  const broker = requestBrokerNotificationMetadata(payload.metadata);
  const title = broker
    ? broker.secretAdd ? "Secret request needs approval" : "Privileged command needs approval"
    : typeof payload.title === "string" ? payload.title.trim() : "";
  const body = broker
    ? truncateNotificationText(broker.secretAdd
      ? `${broker.agentName || "Agent"} asks to add secret ${broker.secretAdd.secretRef} as ${broker.secretAdd.envName}${
        broker.argv.length ? `, then run: ${broker.argv.join(" ")}` : ""}`
      : `${broker.agentName || "Agent"} requested: ${broker.argv.join(" ")}`)
    : payload.body;
  const channelId = typeof payload.channelId === "string" ? payload.channelId.trim() : "";
  const canReply = !broker && platform === "darwin" && Boolean(channelId);

  return {
    show: Boolean(title),
    options: {
      title,
      body,
      silent: payload.silent,
      hasReply: canReply,
      replyPlaceholder: canReply ? "Reply" : undefined,
    },
    canReply,
    channelId,
  };
}

function requestBrokerNotificationMetadata(
  metadata: Record<string, unknown> | undefined
): { argv: string[]; agentName?: string; secretAdd?: { secretRef: string; envName: string } } | null {
  const value = metadata?.requestBroker;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.phase !== "pending") return null;
  const argv = Array.isArray(record.argv)
    ? record.argv.map((item) => (typeof item === "string" ? item : "")).filter(Boolean)
    : [];
  const secretAdd = record.kind === "secret_add" ? requestBrokerSecretAddNotification(record.secretAdd) : null;
  if (argv.length === 0 && !secretAdd) return null;
  return {
    argv,
    ...(secretAdd ? { secretAdd } : {}),
    agentName:
      typeof record.agentName === "string" && record.agentName.trim()
        ? record.agentName.trim()
        : undefined,
  };
}

function requestBrokerSecretAddNotification(value: unknown): { secretRef: string; envName: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const secretRef = typeof record.secretRef === "string" ? record.secretRef.trim() : "";
  const envName = typeof record.envName === "string" ? record.envName.trim() : "";
  return secretRef && envName ? { secretRef, envName } : null;
}

function truncateNotificationText(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
