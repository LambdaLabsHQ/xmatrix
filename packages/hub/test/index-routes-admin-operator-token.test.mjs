import assert from "node:assert/strict";
import { test } from "node:test";

import * as operator from "../src/admin-operator-token.ts";

const TOKEN = `operator-${"0123456789abcdef".repeat(4)}`;

function request(headers = {}) {
  return new Request("https://hub.test/api/admin/trace-access-partitions/3", { headers });
}

function bearer(value = TOKEN) {
  return { authorization: `Bearer ${value}` };
}

test("the operator token authorizes only an exact bearer match of a strong secret", async () => {
  const env = { CONTROL_PLANE_OPERATOR_TOKEN: TOKEN };
  assert.equal(await operator.operatorTokenAuthorizes(request(bearer()), env), true);
  assert.equal(
    await operator.operatorTokenAuthorizes(request(bearer(`  ${TOKEN}  `)), env), true,
    "surrounding whitespace in the header value is tolerated",
  );
  for (const [scenario, headers, scopedEnv] of [
    ["wrong token", bearer("intruder".padEnd(64, "x")), env],
    ["token prefix", bearer(TOKEN.slice(0, TOKEN.length - 1)), env],
    ["missing header", {}, env],
    ["non-bearer scheme", { authorization: `Token ${TOKEN}` }, env],
    ["empty bearer", { authorization: "Bearer " }, env],
    ["missing deployment secret", bearer(), {}],
    ["short deployment secret", bearer("too-short"), { CONTROL_PLANE_OPERATOR_TOKEN: "too-short" }],
  ]) {
    assert.equal(
      await operator.operatorTokenAuthorizes(request(headers), scopedEnv), false,
      `${scenario} must not authorize`,
    );
  }
  assert.ok(
    TOKEN.length >= operator.CONTROL_PLANE_OPERATOR_TOKEN_MIN_LENGTH,
    "the fixture token must satisfy the strength floor",
  );
});

test("the legacy admin bearer needs an exact match of a strong configured token", async () => {
  const { requireAdmin } = await import("../src/index-shared.ts");
  const strong = { XMATRIX_ADMIN_TOKEN: TOKEN };
  assert.doesNotThrow(() => requireAdmin(request(bearer()), strong));
  for (const headers of [{}, bearer(`${TOKEN}x`), bearer(TOKEN.slice(0, -1)), bearer("")]) {
    assert.throws(() => requireAdmin(request(headers), strong), /admin token/u);
  }
  // A missing or short deployment token disables the path entirely.
  for (const env of [{}, { XMATRIX_ADMIN_TOKEN: "short-admin-token" }]) {
    assert.throws(() => requireAdmin(request(bearer(env.XMATRIX_ADMIN_TOKEN ?? "")), env), /admin token/u);
  }
});
