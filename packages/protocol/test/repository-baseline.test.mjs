import assert from "node:assert/strict";
import test from "node:test";
import { cleanRepositoryBaseline } from "../dist/repository-baseline.js";

const base = { baseRef: "origin/main", baseOid: "a".repeat(40), confirmedAt: "2026-10-08T10:00:00Z" };

test("baseline presentation retains explicit UTC observations and strips unreviewed fields", () => {
  const value = cleanRepositoryBaseline({ ...base, historyRewritten: false, path: "/PRIVATE", token: "PRIVATE" });
  assert.equal(value.confirmedAt, "2026-10-08T10:00:00.000Z");
  assert.equal(value.historyRewritten, false);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/u);
  assert.equal(cleanRepositoryBaseline({ ...base, confirmedAt: "2026-10-08T11:00:00+01:00" }).confirmedAt, undefined);
  assert.equal(cleanRepositoryBaseline({ ...base, baseOid: "missing" }), undefined);
  assert.equal(cleanRepositoryBaseline({ ...base, baseRef: "origin/main\nPRIVATE" }), undefined);
});

test("unknown or incomplete ancestry cannot carry a divergence notice", () => {
  const noticeKey = "b".repeat(64);
  const remote = { ...base, baseOid: "c".repeat(40) };
  for (const value of [undefined, {}, { ...base, relationship: "diverged", noticeKey },
    { ...base, relationship: "unknown", remote, noticeKey }]) {
    assert.equal(cleanRepositoryBaseline(value)?.noticeKey, undefined);
  }
  const divergence = cleanRepositoryBaseline({ ...base, relationship: "diverged", remote, noticeKey });
  assert.equal(divergence.noticeKey, noticeKey);
  assert.equal(divergence.remote.baseOid, remote.baseOid);
  assert.equal(cleanRepositoryBaseline({ ...base, relationship: "ancestor", remote, noticeKey }).noticeKey, undefined);
});
