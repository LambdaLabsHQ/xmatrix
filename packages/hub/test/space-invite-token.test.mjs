import assert from "node:assert/strict";
import { test } from "node:test";

import {
  spaceIdFromInviteToken,
  spaceInviteAuthorityScope,
} from "../src/space-invite-token.ts";

/** A routed v1 invite for `spaceId`, as earlier Hub releases minted them. */
const routedInvite = (spaceId) => `v1.${Buffer.from(spaceId).toString("base64url")}.${"a".repeat(64)}`;

test("Space invite tokens carry one canonical authority route", () => {
  const token = routedInvite("space:team-1");
  assert.equal(spaceIdFromInviteToken(token), "space:team-1");
  assert.equal(spaceIdFromInviteToken(`${token}x`), null);
  assert.equal(spaceIdFromInviteToken(token.replace("v1.", "legacy.")), null);
});

test("Space invite routing rejects malformed or non-canonical input", () => {
  for (const token of ["", "v1", "v1...", "v1.Zm9v.short", "v1.Zm9v*." + "a".repeat(64)]) {
    assert.equal(spaceIdFromInviteToken(token), null);
  }
});

test("opaque invites route to the global hash authority; routed invites to their Space", () => {
  assert.deepEqual(spaceInviteAuthorityScope("a".repeat(64)), { kind: "global" });
  for (const token of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64),
    ` ${"a".repeat(64)}`, "v1.invalid." + "a".repeat(64)]) {
    assert.equal(spaceInviteAuthorityScope(token), null);
  }
  assert.deepEqual(spaceInviteAuthorityScope(routedInvite("space:team-1")),
    { kind: "space", spaceId: "space:team-1" });
});
