import assert from "node:assert/strict";
import { test } from "node:test";

import { internalAddress } from "../src/internal-accounts.ts";

test("operator domains, plus addresses and platform admins are internal; customers are not", () => {
  const env = { PLATFORM_ADMIN_EMAILS: "Owner@Example.com" };
  for (const address of ["hello@madebyrobot.net", "a@XMATRIX.sh", "x@madebyrobot.llc", "qa+1@gmail.com", "owner@example.com"]) {
    assert.equal(internalAddress(env, address), true, address);
  }
  assert.equal(internalAddress(env, "Boss@Gmail.com", new Set(["boss@gmail.com"])), true, "a listed personal address");
  for (const address of ["someone@gmail.com", "x@madebyrobot.net.evil.com", "", undefined, "nobody"]) {
    assert.equal(internalAddress(env, address), false, String(address));
  }
});
