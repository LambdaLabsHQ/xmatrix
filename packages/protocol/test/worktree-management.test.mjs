import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorktreeActionRequest, parseWorktreeActionResult, WORKTREE_RECLAIM_PATHS_MAX } from "../dist/index.js";

const requestId = "worktree:00000000-0000-4000-8000-000000000001";
const tree = { path: "/tmp/fix", origin: "manual", locked: false, missing: false, inUse: false, idleSecs: 90_000,
  sizeBytes: 1_024, unlanded: true, branch: "fix/ci" };

test("a request names an action, and paths only for reclaim", () => {
  assert.deepEqual(parseWorktreeActionRequest({ requestId, action: "list", extra: 1 }), { requestId, action: "list" });
  assert.deepEqual(parseWorktreeActionRequest({ requestId, action: "reclaim", paths: ["/tmp/a"] }),
    { requestId, action: "reclaim", paths: ["/tmp/a"] });
  for (const value of [{ requestId, action: "purge" }, { requestId: "harness:x", action: "list" },
    { requestId, action: "list", paths: ["/tmp/a"] }, { requestId, action: "reclaim" },
    { requestId, action: "reclaim", paths: [] }, { requestId, action: "reclaim", paths: ["/tmp/a", "/tmp/a"] },
    { requestId, action: "reclaim", paths: ["/tmp/a\nb"] },
    { requestId, action: "reclaim", paths: Array.from({ length: WORKTREE_RECLAIM_PATHS_MAX + 1 }, (_, i) => `/tmp/${i}`) },
  ]) assert.throws(() => parseWorktreeActionRequest(value), JSON.stringify(value).slice(0, 80));
});

test("a listing is bounded and strips unknown fields", () => {
  const issued = { requestId, action: "list" };
  const result = parseWorktreeActionResult({ action: "list", status: "succeeded", inventory: {
    capturedAt: "2026-10-08T21:00:00Z", foreignAutoReclaim: false, trees: [{ ...tree, secret: "x" }] } }, issued);
  assert.deepEqual(result.inventory.trees, [tree]);
  for (const patch of [{ origin: "vim" }, { path: "" }, { sizeBytes: -1 }, { inUse: "no" }, { branch: "a\u0000" }]) {
    assert.throws(() => parseWorktreeActionResult({ action: "list", status: "succeeded", inventory: {
      capturedAt: "2026-10-08T21:00:00Z", foreignAutoReclaim: false, trees: [{ ...tree, ...patch }] } }, issued));
  }
  assert.throws(() => parseWorktreeActionResult({ action: "reclaim", status: "succeeded" }, issued));
});

test("reclaim reports only the paths it was asked for", () => {
  const issued = { requestId, action: "reclaim", paths: ["/tmp/a", "/tmp/b"] };
  assert.deepEqual(parseWorktreeActionResult({ action: "reclaim", status: "succeeded",
    reclaimed: [{ path: "/tmp/a", snapshotted: true }], kept: [{ path: "/tmp/b", reason: "in use" }] }, issued), {
    action: "reclaim", status: "succeeded", reclaimed: [{ path: "/tmp/a", snapshotted: true }],
    kept: [{ path: "/tmp/b", reason: "in use" }] });
  assert.throws(() => parseWorktreeActionResult({ action: "reclaim", status: "succeeded",
    reclaimed: [{ path: "/home/me", snapshotted: false }] }, issued));
  assert.throws(() => parseWorktreeActionResult({ action: "reclaim", status: "succeeded", inventory: {
    capturedAt: "2026-10-08T21:00:00Z", foreignAutoReclaim: false, trees: [] } }, issued));
});
