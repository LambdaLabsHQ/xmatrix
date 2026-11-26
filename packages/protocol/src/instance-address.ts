/**
 * The one answer to "does this text address that Instance?".
 *
 * An Instance is `@<name>:<N>`: `N` is its ordinal, unique in its Channel, and
 * `<name>` is any name it answers to (its display name, its harness, its
 * Profile or Instance id). A mention hits when both match, and nothing else
 * decides it.
 *
 * Message append (which records the targets a message resolved to), live
 * delivery, catch-up replay and the steer/interrupt call each used to carry
 * their own mapping. They drifted: delivery dropped a name another live
 * Instance shared, so `@antigravity:2` resolved at append and woke no one when
 * `antigravity:1` was also live. Every caller asks here instead.
 */
import { filterOperationalMentions } from "./operational-mention-context.js";
import { mentionAddressTokens, scanMentionAddresses } from "./mention-address.js";

/** An Instance as an address can name it. */
export interface AddressableInstance {
  /** Every name it answers to; blanks are ignored. */
  readonly names: Iterable<string | null | undefined>;
  /** Its ordinal in its Channel. */
  readonly ordinal: string | number | null | undefined;
}

/** The `name:N` tokens that address this Instance. */
function instanceAddressTokens(instance: AddressableInstance): string[] {
  const ordinal = String(instance.ordinal ?? "").trim();
  if (!/^[1-9]\d*$/u.test(ordinal)) return [];
  const names = [...instance.names].map((name) => name?.trim() ?? "").filter(Boolean);
  return mentionAddressTokens(names.map((name) => `${name}:${ordinal}`));
}

/**
 * Whether `body` addresses this Instance by an exact `@name:N` mention that is
 * operational (not quoted, not in code). Case-insensitive, `@` or `＠`.
 */
export function addressesInstance(body: string, instance: AddressableInstance): boolean {
  const tokens = instanceAddressTokens(instance);
  if (!body || !tokens.length) return false;
  return filterOperationalMentions(body, scanMentionAddresses(body, tokens)).length > 0;
}
