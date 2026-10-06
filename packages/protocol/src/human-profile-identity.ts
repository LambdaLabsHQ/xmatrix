import { hasControlCharacter } from "./field-validation.js";
/**
 * The two names a Human carries, and the one place their rules live.
 *
 * A person has a `displayName` — used for presentation and Human mentions —
 * and a `handle`, retained as an alternate address for compatibility and
 * disambiguation. Display names need not be unique: mention resolution rejects
 * ambiguous matches instead of treating a mutable name as identity.
 *
 * Registration, self-service rename, and the backfill that fills in accounts
 * created before any of this existed all have to agree on what a legal name
 * is. When those three disagree, the migration writes rows the product later
 * refuses to accept. So the rules are stated once, here, in the package both
 * the Hub and the clients already depend on.
 *
 * Deliberately absent: any derivation from an email address. Accounts signed
 * up with a QQ address have an all-digit local part, and seeding identity from
 * it is the defect this module exists to end — a handle of `3070845716` tells
 * a reader nothing and an agent reading the message body even less. Callers
 * pass a display name; when nothing usable can be derived from it, they get
 * `undefined` and are expected to fall back to a neutral generated value.
 */

/**
 * A Human handle is a strict subset of the grammar Agent names already
 * use — same ASCII alphanumerics, but hyphen as the only separator where an
 * Agent name also admits `.` and `_`. Both are addressed through the same `@`,
 * so a reader should not have to know which kind of participant they are
 * naming; the narrower set exists because Human handles are claimed by people
 * who may want to be mistaken for one another, and `legend.wang` sitting
 * beside `legend-wang` is an impersonation waiting to happen. Agent names are
 * assigned by whoever runs the agent and stay as they are.
 *
 * Uniqueness is not shared either: Agent names are unique per Space, a Human
 * handle is unique globally.
 */
export const HUMAN_HANDLE_MIN_LENGTH = 3;
export const HUMAN_HANDLE_MAX_LENGTH = 32;

/**
 * Storage already bounds a member display name at 200 bytes. The validator
 * matches that bound rather than tightening it: the backfill re-validates rows
 * that were written under the old rule, and a stricter ceiling here would
 * reject names the database is perfectly happy to hold.
 */
export const HUMAN_DISPLAY_NAME_MAX_LENGTH = 200;

/**
 * Names the product answers to itself. `xmatrix` is load-bearing rather than
 * decorative — the Hub routes `@xmatrix` to the management delegate by a
 * hardcoded pattern, so a person holding that handle would be unaddressable
 * and would make every message mentioning them summon an agent. The rest are
 * reserved on the same principle before anyone can claim them.
 */
export const RESERVED_HUMAN_HANDLES: readonly string[] = [
  "auto",
  "admin",
  "support",
  "system",
  "xmatrix",
];

export type HumanHandleRefusal =
  | "handle_required"
  | "handle_too_short"
  | "handle_too_long"
  | "handle_charset"
  | "handle_boundary"
  | "handle_reserved";

export type HumanDisplayNameRefusal =
  | "display_name_required"
  | "display_name_too_long"
  | "display_name_control_characters";

/**
 * The one canonical form of a handle — what gets validated, compared, stored,
 * and shown. There is deliberately no second "key" concept beside it: once the
 * stored form is already canonical, a separate uniqueness key is just a way for
 * some future code path to compare the wrong one of the two.
 *
 * It does exactly one thing: trim, then lowercase ASCII letters. It does not
 * delete characters, collapse hyphens, or otherwise repair illegal input —
 * `legend_wang` and `legend--wang` come back unchanged and are then refused by
 * `humanHandleRefusal`. A canonicalizer that quietly rewrote them would hand
 * the person a different, valid address than the one they typed, which is a
 * worse outcome than telling them no.
 *
 * Only `A`–`Z` are lowered, rather than calling `toLowerCase()`, because that
 * is Unicode-aware and locale-sensitive: `İ` lowercases into two code points,
 * which would make canonicalization change the length of a string it is
 * supposed to leave alone. Non-ASCII survives untouched and is refused for the
 * character set it is.
 */
export function canonicalHumanHandle(handle: string): string {
  return handle.trim().replace(/[A-Z]/gu, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

export function isReservedHumanHandle(handle: string): boolean {
  return RESERVED_HUMAN_HANDLES.includes(canonicalHumanHandle(handle));
}

/**
 * Why this handle cannot be used, or `undefined` when it is fine.
 *
 * Judges the canonical form, so typing `Legend-Wang` is accepted and becomes
 * `legend-wang` rather than being reported as an error — case is the one thing
 * a person should not have to get right. Everything else is judged exactly as
 * they typed it.
 *
 * Returns a code rather than a sentence so the caller owns the wording and a
 * client can branch on the reason without matching on prose.
 */
export function humanHandleRefusal(value: unknown): HumanHandleRefusal | undefined {
  if (typeof value !== "string") return "handle_required";
  const handle = canonicalHumanHandle(value);
  if (!handle) return "handle_required";
  // Shape is checked before size on purpose. A two-character Chinese name
  // fails both, and being told it is "too short" would send the person off to
  // add a third character that is just as unusable; being told the character
  // set is wrong is the one message that leads somewhere.
  if (!/^[a-z0-9-]+$/u.test(handle)) return "handle_charset";
  // A hyphen at either end, or two in a row, reads as a typo and makes
  // `@legend-` ambiguous against sentence punctuation. Alphanumeric edges also
  // keep a handle clear of the `:new` / `:once` summon suffixes, whose colon
  // cannot appear here at all.
  if (!/^[a-z0-9]/u.test(handle) || !/[a-z0-9]$/u.test(handle)) return "handle_boundary";
  if (/--/u.test(handle)) return "handle_boundary";
  if (handle.length < HUMAN_HANDLE_MIN_LENGTH) return "handle_too_short";
  if (handle.length > HUMAN_HANDLE_MAX_LENGTH) return "handle_too_long";
  if (isReservedHumanHandle(handle)) return "handle_reserved";
  return undefined;
}

export function isValidHumanHandle(value: unknown): value is string {
  return humanHandleRefusal(value) === undefined;
}

/**
 * Display names allow CJK, spaces, and punctuation. Mention resolution owns
 * ambiguity checks; profile validation only refuses emptiness, the storage
 * bound, and control characters.
 */
export function humanDisplayNameRefusal(value: unknown): HumanDisplayNameRefusal | undefined {
  if (typeof value !== "string") return "display_name_required";
  const displayName = value.trim();
  if (!displayName) return "display_name_required";
  if (displayName.length > HUMAN_DISPLAY_NAME_MAX_LENGTH) return "display_name_too_long";
  if (hasControlCharacter(displayName)) return "display_name_control_characters";
  return undefined;
}

/** A display name that is really an address, or really an account number. */
export function isUnusableHumanIdentitySource(displayName: unknown): boolean {
  if (typeof displayName !== "string") return true;
  const source = displayName.trim();
  if (!source) return true;
  if (source.includes("@")) return true;
  // An all-digit name is the QQ-address case wearing a different hat. Deriving
  // from it reproduces exactly the identifier this module refuses to mint.
  return /^\d+$/u.test(source.replace(/[\s._-]/gu, ""));
}

/**
 * A handle candidate derived from what the person just typed as their name.
 *
 * Best-effort by construction: it only carries over characters that are already
 * ASCII, so a wholly non-Latin name yields nothing and returns `undefined`.
 * That is the honest outcome rather than a failure — the caller offers a
 * neutral generated handle instead, and the person edits it. There is no
 * romanization step on purpose: guessing at a reading gets 多音字, minority
 * names, and Hong Kong or Taiwan spellings wrong, and a name is not something
 * to be wrong about on someone's behalf.
 */
export function suggestHumanHandle(displayName: unknown): string | undefined {
  if (typeof displayName !== "string") return undefined;
  const source = displayName.trim();
  if (isUnusableHumanIdentitySource(source)) return undefined;

  const candidate = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, HUMAN_HANDLE_MAX_LENGTH)
    .replace(/-+$/gu, "");

  // Dropping the non-ASCII part of a mixed name can leave nothing but digits —
  // `王力2024` reduces to `2024`, which slips past the all-digit check on the
  // source and hands back exactly the meaningless number this module exists to
  // stop minting. A candidate has to carry at least one letter to be a name at
  // all; anything else goes to the neutral fallback like any other miss.
  if (!/[a-z]/u.test(candidate)) return undefined;

  return isValidHumanHandle(candidate) ? candidate : undefined;
}

/**
 * The fallback pair for an account whose name nobody can responsibly guess.
 *
 * The caller supplies the short code so this stays pure and a migration can be
 * re-run to the same result. Both halves are generated together on purpose:
 * showing `User 3f9a2c` next to `@user-3f9a2c` reads as one deliberate
 * placeholder rather than two unrelated accidents, and it tells the person
 * exactly what they are being invited to replace.
 */
export function neutralHumanIdentity(shortCode: string): { displayName: string; handle: string } {
  const code = shortCode.trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (code.length < HUMAN_HANDLE_MIN_LENGTH) {
    throw new Error("neutral identity needs a short code of at least 3 alphanumeric characters");
  }
  return { displayName: `User ${code}`, handle: `user-${code}`.slice(0, HUMAN_HANDLE_MAX_LENGTH) };
}

/** The short code a generated handle is disambiguated with, taken from an id. */
export function humanHandleShortCode(userId: string): string | undefined {
  const code = userId.trim().toLowerCase().replace(/[^a-z0-9]/gu, "").slice(-6);
  return code.length >= HUMAN_HANDLE_MIN_LENGTH ? code : undefined;
}

/**
 * Every handle to try for one account, best first, when nobody has chosen one.
 *
 * Ordered rather than single because the first choice is the only good one and
 * it is also the one most likely to be taken: two people called 王力 both
 * derive nothing, and two called Legend Wang both derive `legend-wang`. The
 * caller walks the list and takes the first free entry.
 *
 * The short code comes from the account id, so the whole list is a pure
 * function of the row. A backfill interrupted halfway and re-run lands on the
 * same handle for the same person instead of minting a second one, and a
 * caller can compute what an account *would* get without writing anything.
 *
 * The neutral pair is always last and always valid, so this never returns
 * empty for a usable id — nobody ends up with no address because their name
 * happened to be unrepresentable.
 */
export function humanHandleMintCandidates(displayName: unknown, userId: string): string[] {
  const shortCode = humanHandleShortCode(userId);
  if (!shortCode) return [];
  const suggestion = suggestHumanHandle(displayName);
  const candidates: string[] = [];
  if (suggestion) {
    candidates.push(suggestion);
    // Trimming the suggestion, rather than the code, keeps the disambiguated
    // form recognisable as the same person's name at the length ceiling.
    const suffix = `-${shortCode}`;
    candidates.push(`${suggestion.slice(0, HUMAN_HANDLE_MAX_LENGTH - suffix.length)}${suffix}`);
  }
  candidates.push(neutralHumanIdentity(shortCode).handle);
  return [...new Set(candidates)].filter(isValidHumanHandle);
}

/** The storage bound on an IANA zone name; the longest real one is well under this. */
export const HUMAN_TIME_ZONE_MAX_LENGTH = 64;

/**
 * Refuse a time zone that is not a real IANA zone.
 *
 * Validated by asking the platform's own zone database rather than by pattern,
 * because the shape of a zone name is not the question — `Asia/Shanghai` and
 * `Asia/Shanghia` are equally well-formed and only one of them exists. A stored
 * zone that no runtime recognises is worse than a missing one: a missing zone
 * makes a reader say it does not know, while a bogus one makes every render
 * that consults it throw or silently fall back without saying so.
 *
 * The shape check still runs first, so a hostile value never reaches `Intl`.
 */
export function humanTimeZoneRefusal(value: unknown): "time_zone_invalid" | undefined {
  if (typeof value !== "string") return "time_zone_invalid";
  const timeZone = value.trim();
  if (!timeZone || timeZone.length > HUMAN_TIME_ZONE_MAX_LENGTH) return "time_zone_invalid";
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u.test(timeZone)) return "time_zone_invalid";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return "time_zone_invalid";
  }
  return undefined;
}
