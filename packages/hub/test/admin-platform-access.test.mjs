import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isPlatformAdminEmail,
  platformAdminEmails,
  platformAdminSpaceId,
  resolvePlatformAdmin,
} from "../src/admin-platform-access.ts";

/** Membership probe that records what it was asked, so callers can assert it. */
function memberProbe(members = new Set(), calls = []) {
  return {
    calls,
    probe: async (spaceId, userId) => {
      calls.push({ spaceId, userId });
      return members.has(`${spaceId}:${userId}`);
    },
  };
}

test("the allowlist is parsed from separated entries and normalized", () => {
  assert.deepEqual(platformAdminEmails({}), []);
  assert.deepEqual(platformAdminEmails({ PLATFORM_ADMIN_EMAILS: "   " }), []);
  assert.deepEqual(
    platformAdminEmails({ PLATFORM_ADMIN_EMAILS: "Ops@Example.com, second@example.com" }),
    ["ops@example.com", "second@example.com"],
  );
  assert.deepEqual(
    platformAdminEmails({ PLATFORM_ADMIN_EMAILS: "ops@example.com\nops@example.com; third@x.io" }),
    ["ops@example.com", "third@x.io"],
  );
  // A malformed entry must not widen the allowlist.
  assert.deepEqual(
    platformAdminEmails({ PLATFORM_ADMIN_EMAILS: "not-an-email, *, ops@example.com" }),
    ["ops@example.com"],
  );
});

test("only an allowlisted human principal matches the email grant", () => {
  const env = { PLATFORM_ADMIN_EMAILS: "ops@example.com" };
  assert.equal(isPlatformAdminEmail({ email: "ops@example.com" }, env), true);
  assert.equal(isPlatformAdminEmail({ email: "OPS@Example.com " }, env), true);
  assert.equal(isPlatformAdminEmail({ email: "other@example.com" }, env), false);
  assert.equal(isPlatformAdminEmail({ email: "" }, env), false);
  assert.equal(isPlatformAdminEmail({ email: "ops@example.com" }, {}), false);
});

test("the admin Space id is deployment-owned and bounded", () => {
  assert.equal(platformAdminSpaceId({}), "");
  assert.equal(platformAdminSpaceId({ PLATFORM_ADMIN_SPACE_ID: "  " }), "");
  assert.equal(platformAdminSpaceId({ PLATFORM_ADMIN_SPACE_ID: " space:ops " }), "space:ops");
  assert.equal(platformAdminSpaceId({ PLATFORM_ADMIN_SPACE_ID: "x".repeat(181) }), "");
});

test("membership of the configured admin Space grants operator authority", async () => {
  const env = { PLATFORM_ADMIN_SPACE_ID: "space:ops" };
  const { probe, calls } = memberProbe(new Set(["space:ops:user:1"]));

  assert.equal(await resolvePlatformAdmin({ id: "user:1", email: "a@x.io" }, env, probe), true);
  assert.equal(await resolvePlatformAdmin({ id: "user:2", email: "b@x.io" }, env, probe), false);
  assert.deepEqual(calls, [
    { spaceId: "space:ops", userId: "user:1" },
    { spaceId: "space:ops", userId: "user:2" },
  ]);
});

test("the email allowlist short-circuits the Space probe", async () => {
  const env = { PLATFORM_ADMIN_EMAILS: "ops@example.com", PLATFORM_ADMIN_SPACE_ID: "space:ops" };
  const { probe, calls } = memberProbe();

  assert.equal(await resolvePlatformAdmin({ id: "user:1", email: "ops@example.com" }, env, probe), true);
  assert.deepEqual(calls, [], "an allowlisted operator needs no membership round trip");
});

test("no configured Space means membership grants nothing", async () => {
  const { probe, calls } = memberProbe(new Set(["space:ops:user:1"]));

  assert.equal(await resolvePlatformAdmin({ id: "user:1", email: "a@x.io" }, {}, probe), false);
  assert.deepEqual(calls, [], "an unset Space id is never probed");
});

test("a delegated agent-run token never inherits its owner's operator authority", async () => {
  const env = { PLATFORM_ADMIN_EMAILS: "ops@example.com", PLATFORM_ADMIN_SPACE_ID: "space:ops" };
  const { probe, calls } = memberProbe(new Set(["space:ops:user:1"]));
  const agent = { id: "user:1", email: "ops@example.com", agentRun: { ownerUserId: "user:1" } };

  assert.equal(isPlatformAdminEmail(agent, env), false);
  assert.equal(await resolvePlatformAdmin(agent, env, probe), false);
  assert.deepEqual(calls, []);
});
