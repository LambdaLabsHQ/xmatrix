/**
 * The one scanner that decides which `@` in a message addresses whom.
 *
 * There used to be two: one in the Hub, deciding who gets an attention row,
 * and one in the web client, deciding which text becomes a mention chip. They
 * were written to agree and did not. The web rule required the character after
 * a name to come from a fixed punctuation set, so `@codex的输出` was a mention
 * to the Hub -- which notified codex -- and ordinary text to the client, which
 * rendered no chip. A reader got a notification for a mention they could not
 * see in the message.
 *
 * That is not a bug either copy could be "fixed" into agreement, because
 * agreement was never checkable: two loops over two token tables with two
 * boundary rules drift again on the next edit. So the grammar lives here once
 * and both sides call it.
 *
 * What this scanner does NOT decide is who a token belongs to. It reports the
 * spans and the token each one matched; mapping a token to a person or an
 * agent is the caller's, because only the Hub can see a Space's membership and
 * only the client knows what it is allowed to render.
 */

/**
 * A mention opens at the start of the body or after whitespace, a bracket, or
 * a quote -- including the CJK forms people actually write mentions inside, so
 * `（@codex）` addresses codex.
 */
const MENTION_OPEN_BOUNDARY = /[\s([{"'“”‘’（）【】《》「」『』、，。；：！？]/u;

/**
 * Control syntax that rides along after the identity: `:new`, `:once`,
 * `:reborn`, instance ordinals, `:handoff:@successor`. It is consumed so the
 * mention ends where the *name* ends, and ignored because it addresses the
 * same subject either way.
 */
import { agentInvocationTailLength } from "./agent-mention.js";

const MENTION_CONTROL_TAIL = /^(?::[^\s\]}),.;!?]+)+/u;

/** Names that address every member of a Channel rather than one. */
export const MENTION_BROADCAST_NAMES: readonly string[] = ["everyone", "channel", "all", "here"];

export interface MentionAddressMatch {
  /** Index of the `@` itself. */
  start: number;
  /** Index just past the mention, control tail included. */
  end: number;
  /** The matched token, already canonical (trimmed, lowercased). */
  token: string;
}

/** Validate an opening position in the original, undecoded message. */
export function isMentionAddressStart(body: string, index: number): boolean {
  return (body[index] === "@" || body[index] === "＠") && opensMention(body, index);
}

/** The single canonical form a token is compared in. */
export function canonicalMentionToken(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Tokens ordered so the longest wins.
 *
 * Without this `@codex-mba` resolves to `codex`, because a shorter registered
 * name is a prefix of some longer one someone will eventually register.
 * Duplicates collapse, so a caller may pass the same token from several
 * sources without changing the result.
 */
export function mentionAddressTokens(names: Iterable<string>): string[] {
  const tokens = new Set<string>();
  for (const name of names) {
    const token = canonicalMentionToken(name || "");
    if (token) tokens.add(token);
  }
  return [...tokens].sort((left, right) => right.length - left.length);
}

function opensMention(body: string, index: number): boolean {
  if (index === 0) return true;
  return MENTION_OPEN_BOUNDARY.test(body[index - 1]!);
}

/**
 * A name has to end where the mention ends, or `@codexfoo` addresses codex.
 *
 * "Ends" means the next character cannot continue a name: word characters and
 * hyphens do, everything else -- punctuation, whitespace, and every CJK
 * character -- does not. Judging by what may *follow* instead, as one of the
 * two old copies did, silently dropped every mention written against Chinese
 * text.
 */
function nameEndsHere(rest: string, name: string): boolean {
  if (!rest.startsWith(name)) return false;
  return !/^[\w-]/u.test(rest.slice(name.length));
}

/**
 * Every mention in the body, in order, longest token first at each position.
 *
 * `tokens` must come from {@link mentionAddressTokens}; passing an unsorted
 * list quietly reintroduces the prefix bug this ordering exists to prevent.
 */
export function scanMentionAddresses(
  body: string,
  tokens: readonly string[],
): MentionAddressMatch[] {
  if (!body || tokens.length === 0) return [];
  const lowered = body.toLowerCase();
  const matches: MentionAddressMatch[] = [];

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "@" && character !== "＠") continue;
    if (!opensMention(body, index)) continue;

    const rest = lowered.slice(index + 1);
    const token = tokens.find((candidate) => nameEndsHere(rest, candidate));
    if (!token) continue;

    const suffix = rest.slice(token.length);
    const tailLength = agentInvocationTailLength(suffix) ?? MENTION_CONTROL_TAIL.exec(suffix)?.[0].length ?? 0;
    const end = index + 1 + token.length + tailLength;
    matches.push({ start: index, end, token });
    // Resume past this mention so a control tail cannot be rescanned as one.
    index = end - 1;
  }

  return matches;
}
