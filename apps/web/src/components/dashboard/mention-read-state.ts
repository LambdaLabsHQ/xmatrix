/**
 * Mention read state, resolved where the `@` is written.
 *
 * A Channel member's read cursor (`SerializedChannel.memberReadSequences`) is
 * the same durable fact the caller sees as `readSequence`, projected for every
 * member. A mention is read exactly when the mentioned member's cursor has
 * reached the message's sequence, so this module holds the two pure pieces the
 * renderer needs: which member a mention token points at, and what that
 * member's cursor says about one message.
 *
 * A server-sent `ChannelMessage.mentionReadStatuses` entry, when present, wins:
 * it is the Hub's own judgement for targets a client cannot resolve.
 */
import type {
  ChannelMentionReadState,
  ChannelMentionReadStatus,
  SerializedAgentLaunch,
  SerializedChannel,
} from "@xmatrix/protocol";
import { MENTION_BROADCAST_NAMES, isChannelResidentInstance, isOperationalMentionStart, mentionAddressTokens, nonOperationalMentionRanges, parseAutoLaunchMentions,
  parseHarnessCapabilityMentions, scanMentionAddresses } from "@xmatrix/protocol";

import type { MentionCandidate } from "./mention-complete";

export type MentionReadTarget = {
  /** Durable subject identity used by delivery cursors. */
  subjectId: string;
  kind: "user" | "agent";
  label: string;
  avatarUrl?: string;
  /** A written lifecycle phrase the Channel index could not resolve yet. It
      still gets the `@` highlight, but it must never borrow a real member's
      read cursor, so its read state is always `unknown`. */
  unresolved?: boolean;
};

export type MentionSegment =
  | { kind: "text"; text: string }
  /** `token` is the address that resolved this mention, so the renderer can
      swap just that prefix for the reader-facing name. */
  | { kind: "mention"; text: string; token: string; target: MentionReadTarget };

/**
 * What a mention reads as.
 *
 * New mentions use display names. Existing handle mentions render with the
 * current display name too, while retaining the original message text.
 *
 * Control syntax is not identity, so a written tail (`:new`, `:once`, an
 * instance ordinal, `:reborn`, `:handoff:@successor`) is preserved exactly as
 * the sender typed it and follows the name. `@eevee:3:reborn` therefore reads
 * as `@Legend Wang:3:reborn`: the reader sees who, and the command survives.
 */
export function mentionChipLabel(text: string, targetLabel: string, token?: string): string {
  const source = text.trim().replace(/^[@＠]/u, "");
  const label = targetLabel.trim().replace(/^[@＠]/u, "");
  if (!source) return label;
  if (!label || !token) return source;
  // Only the identity prefix is swapped, and only when it is the token that
  // actually resolved this mention -- never a coincidental prefix of the tail.
  const prefix = source.slice(0, token.length);
  if (prefix.toLowerCase() !== token.toLowerCase()) return source;
  return `${label}${source.slice(token.length)}`;
}

/** Token → member. Ordering and matching come from the shared grammar. */
export type MentionReadIndex = {
  tokens: string[];
  byToken: Map<string, MentionReadTarget>;
};

/** Display names and legacy handles share one ambiguity-checked namespace. */
export function buildMentionReadIndex(
  candidates: readonly MentionCandidate[],
): MentionReadIndex {
  const byToken = new Map<string, MentionReadTarget>();
  const ambiguous = new Set<string>(MENTION_BROADCAST_NAMES);
  for (const candidate of candidates) {
    if (candidate.kind === "app") continue;
    const target = mentionReadTarget(candidate);
    if (!target) continue;
    for (const token of mentionTokensFor(candidate)) {
      if (ambiguous.has(token)) continue;
      const prior = byToken.get(token);
      if (prior && prior.subjectId !== target.subjectId) {
        byToken.delete(token);
        ambiguous.add(token);
      } else byToken.set(token, target);
    }
  }
  return { tokens: mentionAddressTokens([...byToken.keys(), ...ambiguous]), byToken };
}

/** Humans accept their displayed name and their existing handle. */
function mentionTokensFor(candidate: MentionCandidate): string[] {
  if (candidate.kind === "user") {
    return mentionAddressTokens([candidate.name, candidate.handle].filter(Boolean) as string[]);
  }
  return mentionAddressTokens([candidate.id, candidate.mention, candidate.name].filter(Boolean) as string[]);
}

function mentionReadTarget(candidate: MentionCandidate): MentionReadTarget | undefined {
  const label = candidate.name?.trim();
  if (!label) return undefined;
  if (candidate.kind === "user") {
    // Human candidates already carry the channel identity form `user:<id>`.
    const subjectId = candidate.id.startsWith("user:") ? candidate.id : `user:${candidate.id}`;
    return { subjectId, kind: "user", label, ...(candidate.avatarUrl ? { avatarUrl: candidate.avatarUrl } : {}) };
  }
  if (candidate.kind !== "agent" || !candidate.id) return undefined;
  return {
    subjectId: candidate.id.startsWith("agent:") ? candidate.id : `agent:${candidate.id}`,
    kind: "agent",
    label,
    ...(candidate.avatarUrl ? { avatarUrl: candidate.avatarUrl } : {}),
  };
}

/**
 * Split one plain-text run into text and resolved mentions. Only members of
 * this Channel produce a mention segment: unresolved `@text` stays text, so a
 * chip never claims a read state for someone the Channel does not know.
 */
export function splitMentionSegments(
  text: string,
  index: MentionReadIndex | null,
): MentionSegment[] {
  if (!text || !index || index.tokens.length === 0) {
    return text ? [{ kind: "text", text }] : [];
  }
  const segments: MentionSegment[] = [];
  let plainFrom = 0;
  for (const match of scanMentionAddresses(text, index.tokens)) {
    const target = index.byToken.get(match.token);
    if (!target) continue;
    if (match.start > plainFrom) {
      segments.push({ kind: "text", text: text.slice(plainFrom, match.start) });
    }
    segments.push({
      kind: "mention",
      text: text.slice(match.start, match.end),
      token: match.token,
      target,
    });
    plainFrom = match.end;
  }
  if (plainFrom < text.length) segments.push({ kind: "text", text: text.slice(plainFrom) });
  return segments;
}

export type MentionReadResolution = {
  state: ChannelMentionReadState;
  readAt?: string;
};

/**
 * Read state of one mention on one message. Unknown is the honest answer for a
 * message with no sequence (an optimistic outbound row) and for a Channel
 * payload that carries no member read projection at all.
 */
export function mentionReadResolution(input: {
  target: MentionReadTarget;
  messageSequence?: number;
  memberReadSequences?: Record<string, number>;
  serverStatuses?: readonly ChannelMentionReadStatus[];
}): MentionReadResolution {
  // A phrase the index could not resolve owns no cursor. Reporting `unread` for
  // it would print a member's read state onto a subject that may not exist.
  if (input.target.unresolved) return { state: "unknown" };
  const server = input.serverStatuses?.find(
    (status) => mentionStatusSubjectId(status) === input.target.subjectId,
  );
  if (server && server.status !== "unknown") {
    return { state: server.status, ...(server.readAt ? { readAt: server.readAt } : {}) };
  }
  if (!input.messageSequence || !input.memberReadSequences) return { state: "unknown" };
  const readSequence = input.memberReadSequences[input.target.subjectId];
  if (readSequence === undefined) return { state: "unread" };
  return { state: readSequence >= input.messageSequence ? "read" : "unread" };
}

/**
 * Mention subjects that cannot read anything right now: an Instance whose
 * machine is unreachable, and an Agent whose every Channel Instance is one.
 * A resting Instance elsewhere still wakes on the mention, so it keeps its
 * Agent off this set. Presence only: it says why a mention stays unread.
 */
export function machineOfflineMentionSubjects(
  channel: Pick<SerializedChannel, "memberPresence"> | null | undefined,
): ReadonlySet<string> {
  const subjects = new Set<string>();
  for (const [memberId, presence] of Object.entries(channel?.memberPresence || {})) {
    if (presence.kind !== "agent") continue;
    const subject = memberId.startsWith("agent:") ? memberId : `agent:${memberId}`;
    const resident = (presence.instances || []).filter(isChannelResidentInstance);
    const unreachable = resident.filter((instance) =>
      instance.status === "offline" && instance.offlineReason === "machine_offline");
    for (const instance of unreachable) subjects.add(`${subject}:${instance.id}`);
    if (unreachable.length > 0 && unreachable.length === resident.length) subjects.add(subject);
  }
  return subjects;
}

function mentionStatusSubjectId(status: ChannelMentionReadStatus): string {
  if (status.targetId.includes(":")) return status.targetId;
  return status.targetKind === "user" ? `user:${status.targetId}` : `agent:${status.targetId}`;
}

/**
 * Merge one live `channel_member_read_updated` cursor into a Channel. A cursor
 * only ever moves forward, so a late or duplicated frame can never roll one
 * member's read state back.
 */
export function withMemberReadSequence(
  channel: SerializedChannel,
  subjectId: string,
  readSequence: number,
): SerializedChannel {
  if (!subjectId || !Number.isSafeInteger(readSequence) || readSequence <= 0) return channel;
  const current = channel.memberReadSequences?.[subjectId];
  if (current !== undefined && current >= readSequence) return channel;
  return {
    ...channel,
    memberReadSequences: { ...channel.memberReadSequences, [subjectId]: readSequence },
  };
}

/**
 * Apply one live `channel_member_read_updated` frame to the Channel list. A
 * malformed or unknown frame leaves the list untouched, by identity, so the
 * caller can apply it unconditionally.
 */
export function applyMemberReadEvent(
  channels: SerializedChannel[],
  event: { channelId?: string; metadata?: Record<string, unknown> },
): SerializedChannel[] {
  const channelId = typeof event.channelId === "string" ? event.channelId : "";
  const subjectId = typeof event.metadata?.subjectId === "string" ? event.metadata.subjectId : "";
  const readSequence = Number(event.metadata?.readSequence);
  if (!channelId || !subjectId) return channels;
  return channels.map((channel) => channel.id === channelId
    ? withMemberReadSequence(channel, subjectId, readSequence)
    : channel);
}

/** A pending Agent need not have joined yet. Resolve its chip from the exact
 * Channel-authorized launch catalog without changing membership/read authority.
 * A unique launch may name a harness that membership left ambiguous (`@codex`
 * when several Codex Profiles share the Space). Conflicting launches keep the
 * shared name unresolved, so callers overlay one message's launches. */
export function withInvocationMentionTargets(index: MentionReadIndex,
  launches: readonly SerializedAgentLaunch[]): MentionReadIndex {
  const byToken = new Map(index.byToken);
  const ambiguous = new Set(index.tokens.filter(token => !byToken.has(token)));
  const launchByToken = new Map<string, { profile: string; label: string; avatarUrl?: string }>();
  const launchConflict = new Set<string>();
  for (const launch of launches) {
    if (!launch.targetName) continue;
    const source = launch.sourceMention?.replace(/^[@＠]/u, "");
    // Instance IDs contain colons. Consume the whole authoritative identity
    // before preserving the lifecycle/repository tail for display.
    const profile = launch.instanceId;
    const writtenToken = source && (source === profile || source.startsWith(`${profile}:`))
      ? profile : source?.match(/^([^:\s]+)/u)?.[1];
    if (writtenToken === "agent") continue;
    for (const token of mentionAddressTokens([launch.targetName, ...(writtenToken ? [writtenToken] : [])])) {
      if (launchConflict.has(token)) continue;
      const bound = launchByToken.get(token);
      if (bound && bound.profile !== profile) {
        launchByToken.delete(token);
        launchConflict.add(token);
        continue;
      }
      launchByToken.set(token, {
        profile,
        label: launch.targetName,
        ...(launch.targetAvatarUrl ? { avatarUrl: launch.targetAvatarUrl } : {}),
      });
    }
  }
  for (const token of launchConflict) {
    byToken.delete(token);
    ambiguous.add(token);
  }
  for (const [token, bound] of launchByToken) {
    if (launchConflict.has(token)) continue;
    ambiguous.delete(token);
    byToken.set(token, {
      subjectId: bound.profile,
      kind: "agent",
      label: bound.label,
      ...(bound.avatarUrl ? { avatarUrl: bound.avatarUrl } : {}),
    });
  }
  return { byToken, tokens: mentionAddressTokens([...byToken.keys(), ...ambiguous]) };
}

/**
 * The `@` is the user's own shout, so it must keep its highlight even when the
 * launch evidence that names its target has not arrived yet (or the Channel's
 * membership left a shared name ambiguous). A harness capability shout
 * (`@codex`) addresses a harness, not a unique member: the written phrase gets
 * an unresolved Agent target the moment it renders, so the chip appears
 * immediately, shows `unknown`, and is replaced by the launch-backed chip the
 * moment `withInvocationMentionTargets` can name it.
 */
export function withWrittenInvocationTargets(index: MentionReadIndex, text: string): MentionReadIndex {
  if (!/[@＠]/u.test(text)) return index;
  const byToken = new Map(index.byToken);
  const ambiguous = new Set(index.tokens.filter(token => !byToken.has(token)));
  for (const shout of parseHarnessCapabilityMentions(text)) {
    const token = shout.text.replace(/^[@＠]/u, "").trim().toLowerCase();
    if (!token || byToken.has(token) || MENTION_BROADCAST_NAMES.includes(token)) continue;
    byToken.set(token, { subjectId: `written:${token}`, kind: "agent", label: token, unresolved: true });
    ambiguous.delete(token);
  }
  return { byToken, tokens: mentionAddressTokens([...byToken.keys(), ...ambiguous]) };
}

export type ComposerMentionSpan = {
  start: number;
  end: number;
  /** `reference` is a picked channel or page the draft shows by name. */
  kind: "user" | "agent" | "summon" | "reference";
  forced?: boolean;
  invalid?: boolean;
  self?: boolean;
  /** Jev's reading of a summon while the author types: still reading, a request, or not one. */
  intent?: "reading" | "summon" | "declined";
};

/**
 * The spans a draft's highlight paints: exactly what the sent message will
 * render as a chip. A summon comes from the launch grammar; any other `@`
 * must resolve to a Channel member through the same scanner and index the
 * timeline uses, so unknown names, `@` inside code or a quote, and the CJK
 * text after a name stay unpainted rather than promising a chip that never
 * appears.
 */
export function composerMentionSpans(text: string, index: MentionReadIndex | null,
  currentUserIdentityId?: string): ComposerMentionSpan[] {
  if (!/[@＠]/u.test(text)) return [];
  const spans: ComposerMentionSpan[] = parseAutoLaunchMentions(text).map(mention => ({
    start: mention.start, end: mention.end, kind: "summon",
    ...(mention.tags.launch === "force" ? { forced: true } : {}),
    ...(mention.error ? { invalid: true } : {}),
  }));
  const written = withWrittenInvocationTargets(index ?? { tokens: [], byToken: new Map() }, text);
  if (written.tokens.length) {
    const ranges = nonOperationalMentionRanges(text);
    for (const match of scanMentionAddresses(text, written.tokens)) {
      const target = written.byToken.get(match.token);
      if (!target || !isOperationalMentionStart(match.start, ranges)) continue;
      if (spans.some(span => span.start < match.end && match.start < span.end)) continue;
      spans.push({ start: match.start, end: match.end, kind: target.kind,
        ...(currentUserIdentityId && target.subjectId === currentUserIdentityId ? { self: true } : {}) });
    }
  }
  return spans.sort((left, right) => left.start - right.start);
}
