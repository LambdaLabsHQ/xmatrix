import type { HumanRuntimeSession } from "./human-port";
import {
  hibernationBoundedJson,
  hibernationClientVersions,
  hibernationBoundedString,
  hibernationHasExactKeys,
  hibernationHasOnlyKeys,
  hibernationRecord,
  hibernationValidDate,
  hibernationValidExpiry,
  nextRuntimeHibernationExpiry,
} from "./hibernation-bounds";

export interface HumanHibernationAttachment {
  version: 1;
  domain: "human";
  expiresAt: string;
  session: HumanRuntimeSession;
}

export function serializeHumanHibernationAttachment(
  session: Readonly<HumanRuntimeSession>,
): HumanHibernationAttachment {
  const parsed = parseHumanHibernationAttachment({ version: 1, domain: "human",
    expiresAt: nextRuntimeHibernationExpiry(), session });
  if (!parsed) throw new Error("Human session cannot be serialized as a bounded hibernation attachment");
  return parsed;
}

export function parseHumanHibernationAttachment(value: unknown): HumanHibernationAttachment | undefined {
  if (!hibernationRecord(value) || !hibernationHasExactKeys(value, ["version", "domain", "expiresAt", "session"]) ||
      value.version !== 1 || value.domain !== "human" || !hibernationValidExpiry(value.expiresAt) || !hibernationBoundedJson(value)) return undefined;
  const session = value.session;
  if (!hibernationRecord(session) ||
      !hibernationHasOnlyKeys(session, [
        "user", "connectedAt", "lastSeenAt", "focusedChannelId",
        "deviceClient", "deviceLabel", "platform", "clientVersion", "clientProtocolVersion", "presenceDigest",
      ]) ||
      !hibernationValidDate(session.connectedAt) || !hibernationValidDate(session.lastSeenAt) ||
      !(session.focusedChannelId === null || hibernationBoundedString(session.focusedChannelId)) ||
      !(session.deviceClient === undefined || hibernationBoundedString(session.deviceClient)) ||
      !(session.deviceLabel === undefined || hibernationBoundedString(session.deviceLabel)) ||
      !(session.platform === undefined || hibernationBoundedString(session.platform)) ||
      !(session.clientVersion === undefined || hibernationBoundedString(session.clientVersion, 64)) ||
      !(session.clientProtocolVersion === undefined ||
        (Number.isSafeInteger(session.clientProtocolVersion) && (session.clientProtocolVersion as number) > 0)) ||
      !(session.presenceDigest === undefined || session.presenceDigest === true)) {
    return undefined;
  }
  const user = session.user;
  if (!hibernationRecord(user) || !hibernationHasOnlyKeys(user, ["id", "email", "name", "avatarUrl"]) ||
      !hibernationBoundedString(user.id) || !hibernationBoundedString(user.email) ||
      !(user.name === undefined || hibernationBoundedString(user.name)) ||
      !(user.avatarUrl === undefined || hibernationBoundedString(user.avatarUrl, 2_048))) return undefined;
  return {
    version: 1,
    domain: "human",
    expiresAt: value.expiresAt,
    session: {
      user: { id: user.id, email: user.email, ...(user.name ? { name: user.name } : {}),
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}) },
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt,
      focusedChannelId: session.focusedChannelId,
      ...(typeof session.deviceClient === "string" ? { deviceClient: session.deviceClient } : {}),
      ...(typeof session.deviceLabel === "string" ? { deviceLabel: session.deviceLabel } : {}),
      ...(typeof session.platform === "string" ? { platform: session.platform } : {}),
      ...hibernationClientVersions(session),
      ...(session.presenceDigest === true ? { presenceDigest: true } : {}),
    },
  };
}
