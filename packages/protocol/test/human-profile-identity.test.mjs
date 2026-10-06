import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const {
  HUMAN_HANDLE_MAX_LENGTH,
  RESERVED_HUMAN_HANDLES,
  canonicalHumanHandle,
  humanDisplayNameRefusal,
  humanHandleMintCandidates,
  isUnusableHumanIdentitySource,
  humanHandleRefusal,
  isReservedHumanHandle,
  isValidHumanHandle,
  neutralHumanIdentity,
  suggestHumanHandle,
} = await loadTypescriptModule(new URL("../src/human-profile-identity.ts", import.meta.url));

test("an ordinary handle is accepted", () => {
  for (const handle of ["legend", "legend-wang", "abc", "a1b2c3", "wang-li-2"]) {
    assert.equal(humanHandleRefusal(handle), undefined, handle);
  }
});

test("only one separator exists, so a confusable twin cannot be registered", () => {
  // The impersonation guard lives here rather than in the uniqueness key: with
  // `.` and `_` refused outright, `legend.wang` never becomes a second account
  // sitting next to `legend-wang`. Folding separators into the key instead
  // would have made `ab` silently collide with `a-b`.
  assert.equal(humanHandleRefusal("legend-wang"), undefined);
  assert.equal(humanHandleRefusal("legend.wang"), "handle_charset");
  assert.equal(humanHandleRefusal("legend_wang"), "handle_charset");
  // And canonicalization stays predictable: differing only by a hyphen is still
  // two distinct handles, which a reader can actually see.
  assert.notEqual(canonicalHumanHandle("a-b"), canonicalHumanHandle("ab"));
});

test("a handle is refused with the reason, not a sentence", () => {
  assert.equal(humanHandleRefusal(undefined), "handle_required");
  assert.equal(humanHandleRefusal("   "), "handle_required");
  assert.equal(humanHandleRefusal("ab"), "handle_too_short");
  assert.equal(humanHandleRefusal("a".repeat(HUMAN_HANDLE_MAX_LENGTH + 1)), "handle_too_long");
  assert.equal(humanHandleRefusal("王力"), "handle_charset");
  assert.equal(humanHandleRefusal("legend wang"), "handle_charset");
  assert.equal(humanHandleRefusal("legend@wang"), "handle_charset");
});

test("the separator may not sit at an edge or double up", () => {
  assert.equal(humanHandleRefusal("-legend"), "handle_boundary");
  assert.equal(humanHandleRefusal("legend-"), "handle_boundary");
  assert.equal(humanHandleRefusal("legend--wang"), "handle_boundary");
});

test("a handle can never carry a summon suffix", () => {
  // `:` is outside the charset, so `@someone:new` can only ever be read as a
  // handle plus a suffix the Hub owns — never as one long handle.
  assert.equal(humanHandleRefusal("legend:new"), "handle_charset");
  assert.equal(humanHandleRefusal("legend:1:reborn"), "handle_charset");
});

test("names the product answers to are not claimable", () => {
  for (const reserved of RESERVED_HUMAN_HANDLES) {
    assert.equal(humanHandleRefusal(reserved), "handle_reserved", reserved);
  }
  // The Hub matches `@xmatrix` case-insensitively, so the reservation has to be
  // case-insensitive too or the guard is trivially stepped around.
  assert.equal(humanHandleRefusal("xMatrix"), "handle_reserved");
  assert.equal(humanHandleRefusal("ADMIN"), "handle_reserved");
  assert.equal(isReservedHumanHandle("Support"), true);
  assert.equal(isReservedHumanHandle("legend"), false);
});

test("case is the one thing a person does not have to get right", () => {
  assert.equal(canonicalHumanHandle("Legend-Wang"), "legend-wang");
  assert.equal(canonicalHumanHandle("  LEGEND  "), "legend");
  // Typing capitals is not an error, just a different spelling of one address.
  assert.equal(humanHandleRefusal("Legend-Wang"), undefined);
  assert.equal(humanHandleRefusal("XMATRIX"), "handle_reserved");
});

test("canonicalization is idempotent", () => {
  for (const input of ["Legend-Wang", "  LEGEND  ", "legend_wang", "legend--wang", "王力", ""]) {
    const once = canonicalHumanHandle(input);
    assert.equal(canonicalHumanHandle(once), once, input);
  }
});

test("the canonicalizer never repairs illegal input into a different address", () => {
  // It lowercases and trims; it deletes and folds nothing. Silently turning
  // `legend_wang` into `legend-wang` would hand the person a valid address they
  // never asked for — and possibly someone else's. Refusing is the honest answer.
  assert.equal(canonicalHumanHandle("legend_wang"), "legend_wang");
  assert.equal(humanHandleRefusal("legend_wang"), "handle_charset");
  assert.equal(canonicalHumanHandle("legend--wang"), "legend--wang");
  assert.equal(humanHandleRefusal("legend--wang"), "handle_boundary");
  assert.equal(canonicalHumanHandle("-legend-"), "-legend-");
  assert.equal(canonicalHumanHandle("王力"), "王力");
  // Lowercasing is ASCII-only on purpose: `toLowerCase()` expands `İ` into two
  // code points, and a canonicalizer that changes length is doing more than
  // spelling.
  assert.equal(canonicalHumanHandle("İ").length, 1);
});

test("display names carry no addressing duty, so they stay permissive", () => {
  for (const displayName of ["王力", "Legend Wang", "José Álvarez", "山田 太郎", "L"]) {
    assert.equal(humanDisplayNameRefusal(displayName), undefined, displayName);
  }
});

test("a display name still may not be empty, oversized, or carry control characters", () => {
  assert.equal(humanDisplayNameRefusal(""), "display_name_required");
  assert.equal(humanDisplayNameRefusal("   "), "display_name_required");
  assert.equal(humanDisplayNameRefusal(null), "display_name_required");
  assert.equal(humanDisplayNameRefusal("a".repeat(201)), "display_name_too_long");
  assert.equal(humanDisplayNameRefusal("Legend\u0000Wang"), "display_name_control_characters");
  assert.equal(humanDisplayNameRefusal("Legend\u001fWang"), "display_name_control_characters");
});

test("a handle candidate is derived from the name the person typed", () => {
  assert.equal(suggestHumanHandle("Legend Wang"), "legend-wang");
  assert.equal(suggestHumanHandle("  Legend   Wang  "), "legend-wang");
  assert.equal(suggestHumanHandle("O'Brien"), "o-brien");
  assert.equal(isValidHumanHandle(suggestHumanHandle("Legend Wang")), true);
});

test("an address is never a source of identity", () => {
  // The whole defect this module exists to end: a QQ signup carries an
  // all-digit local part, and seeding a handle from it just moves the bad
  // identifier into a new field.
  assert.equal(suggestHumanHandle("1234567890@qq.com"), undefined);
  assert.equal(suggestHumanHandle("1234567890"), undefined);
  assert.equal(suggestHumanHandle("307 084 5716"), undefined);
  assert.equal(suggestHumanHandle("legend@example.com"), undefined);
});

test("email-shaped and account-number names require a neutral identity", () => {
  assert.equal(isUnusableHumanIdentitySource("legend@example.com"), true);
  assert.equal(isUnusableHumanIdentitySource("307 084 5716"), true);
  assert.equal(isUnusableHumanIdentitySource("Legend Wang"), false);
  assert.equal(isUnusableHumanIdentitySource("王力"), false);
});

test("what survives a mixed name still has to be a name", () => {
  // Dropping the Chinese half of `王力2024` leaves `2024`. The source is not
  // all digits, so the address guard does not catch it — without a letter
  // requirement the derivation quietly mints the very kind of numeric handle
  // this module exists to prevent.
  assert.equal(suggestHumanHandle("王力2024"), undefined);
  assert.equal(suggestHumanHandle("李 2024"), undefined);
  // A mixed name that keeps real letters is still a good candidate.
  assert.equal(suggestHumanHandle("李 Legend"), "legend");
  assert.equal(suggestHumanHandle("Legend 王"), "legend");
  assert.equal(suggestHumanHandle("wang2024"), "wang2024");
});

test("a name that transcribes to nothing yields nothing rather than a guess", () => {
  assert.equal(suggestHumanHandle("王力"), undefined);
  assert.equal(suggestHumanHandle("山田太郎"), undefined);
  assert.equal(suggestHumanHandle("--"), undefined);
  assert.equal(suggestHumanHandle("Li"), undefined, "shorter than the minimum");
  assert.equal(suggestHumanHandle(""), undefined);
  assert.equal(suggestHumanHandle(undefined), undefined);
});

test("a derived candidate is trimmed to length without a trailing separator", () => {
  const candidate = suggestHumanHandle(`${"a".repeat(30)} wang`);
  assert.equal(candidate.length <= HUMAN_HANDLE_MAX_LENGTH, true);
  assert.equal(humanHandleRefusal(candidate), undefined);
});

test("the neutral fallback reads as one deliberate placeholder", () => {
  assert.deepEqual(neutralHumanIdentity("3f9a2c"), {
    displayName: "User 3f9a2c",
    handle: "user-3f9a2c",
  });
  assert.equal(humanHandleRefusal(neutralHumanIdentity("3f9a2c").handle), undefined);
  // Re-running a migration must land on the same identity, so nothing here may
  // depend on a clock or a random source.
  assert.deepEqual(neutralHumanIdentity("3f9a2c"), neutralHumanIdentity("3F9A2C"));
  assert.throws(() => neutralHumanIdentity("x"), /short code/u);
});

test("mint candidates run best-first and always end somewhere valid", () => {
  const candidates = humanHandleMintCandidates("Legend Wang", "acct-9f3a2c");
  assert.deepEqual(candidates, ["legend-wang", "legend-wang-9f3a2c", "user-9f3a2c"]);
  for (const candidate of candidates) assert.equal(humanHandleRefusal(candidate), undefined);
});

test("a name that transcribes to nothing still yields an address", () => {
  // The whole point of the neutral pair: being unrepresentable in ASCII must
  // not leave someone with no way to be `@`-ed.
  assert.deepEqual(humanHandleMintCandidates("王力", "acct-9f3a2c"), ["user-9f3a2c"]);
  assert.deepEqual(humanHandleMintCandidates(null, "acct-9f3a2c"), ["user-9f3a2c"]);
});

test("mint candidates are a pure function of the row, so a re-run is a no-op", () => {
  // A backfill killed halfway has to compute the same first choice next time,
  // or the second pass mints a second handle for someone who already has one.
  assert.deepEqual(
    humanHandleMintCandidates("Legend Wang", "acct-9f3a2c"),
    humanHandleMintCandidates("Legend Wang", "acct-9f3a2c"),
  );
});

test("the disambiguated form stays inside the length ceiling", () => {
  const candidates = humanHandleMintCandidates(`${"a".repeat(40)} wang`, "acct-9f3a2c");
  for (const candidate of candidates) {
    assert.equal(candidate.length <= HUMAN_HANDLE_MAX_LENGTH, true, candidate);
    assert.equal(humanHandleRefusal(candidate), undefined, candidate);
  }
  assert.equal(candidates.at(-1), "user-9f3a2c");
});

test("an id with too little to work with mints nothing rather than guessing", () => {
  assert.deepEqual(humanHandleMintCandidates("Legend Wang", "--"), []);
});

test("a derived candidate that collides with a reserved name is dropped, not offered", () => {
  // `@xmatrix` routes to the management delegate, so a person called xMatrix
  // must fall through to the neutral pair instead of being handed the name.
  assert.deepEqual(humanHandleMintCandidates("xMatrix", "acct-9f3a2c"), ["user-9f3a2c"]);
});
