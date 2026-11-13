import assert from "node:assert/strict";
import test from "node:test";
import { RECENT_RELEASE_MS, STABLE_RELEASES_KEPT, selectPrunableReleases } from "./prune-r2-release-assets.mjs";

const now = Date.parse("2026-11-13T00:00:00Z");
const old = new Date(now - RECENT_RELEASE_MS - 1).toISOString();
const recent = new Date(now - RECENT_RELEASE_MS + 60_000).toISOString();

function release(tag, modified = old) {
  return [
    { key: `releases/${tag}/xmatrix-linux-x64`, last_modified: modified },
    { key: `releases/${tag}/xmatrix-r2-manifest.json`, last_modified: modified },
  ];
}

function prunedTags(objects, options = {}) {
  return selectPrunableReleases({
    objects,
    currentPrefixes: options.currentPrefixes ?? new Set(),
    prunableComponents: options.prunableComponents ?? new Set(["cli", "desktop", "android"]),
    now,
  }).map((item) => item.prefix.slice("releases/".length));
}

test("keeps the newest stable releases by version, not by upload order", () => {
  const stable = Array.from({ length: STABLE_RELEASES_KEPT + 2 }, (_, index) => `cli-v1.${index + 1}.0`);
  // 1.10.0 sorts before 1.2.0 as text; SemVer puts it after.
  assert.deepEqual(prunedTags(stable.flatMap((tag) => release(tag))), ["cli-v1.1.0", "cli-v1.2.0"]);
});

test("old betas go, last week's releases and the channels' releases stay", () => {
  const objects = [
    ...release("cli-v4.0.0"),
    ...release("cli-v4.0.1-beta.1"),
    ...release("cli-v4.0.1-beta.2"),
    ...release("cli-v4.0.1-beta.3", recent),
    ...release("desktop-v4.0.1-beta.1"),
  ];
  assert.deepEqual(
    prunedTags(objects, { currentPrefixes: new Set(["releases/cli-v4.0.1-beta.2"]) }),
    ["cli-v4.0.1-beta.1", "desktop-v4.0.1-beta.1"]
  );
});

test("a release with any object from the last week stays", () => {
  const objects = [...release("cli-v4.0.1-beta.1"), { key: "releases/cli-v4.0.1-beta.1/parts/linux/1-2/x", last_modified: recent }];
  assert.deepEqual(prunedTags(objects), []);
});

test("a component whose stable channel is unreadable is not pruned, nor is an unknown version", () => {
  const objects = [...release("android-v1.0.0-beta.1"), ...release("cli-v1.0.0-rc.1"), ...release("cli-v1.0.0-beta.1")];
  assert.deepEqual(prunedTags(objects, { prunableComponents: new Set(["cli"]) }), ["cli-v1.0.0-beta.1"]);
});

test("a delete answered with an empty body is asked again", async () => {
  const { pruneR2ReleaseAssets } = await import("./prune-r2-release-assets.mjs");
  const objects = release("cli-v1.0.0-beta.1");
  const pointer = (component, channel) => ({ component, channel, prefix: `releases/${component}-v9.0.0` });
  const deletes = new Map();
  const json = (body) => new Response(JSON.stringify(body), { status: 200 });
  const fetchImpl = async (url) => {
    const channel = /channels\/(\w+)\/(\w+)\.json$/u.exec(url);
    if (channel) return json(pointer(channel[1], channel[2] === "dev" ? "dev" : "stable"));
    if (url.includes("/objects?")) return json({ success: true, result: objects, result_info: { is_truncated: false } });
    const seen = (deletes.get(url) ?? 0) + 1;
    deletes.set(url, seen);
    return seen === 1 ? new Response("", { status: 502 }) : json({ success: true, result: {} });
  };
  const deleted = await pruneR2ReleaseAssets({ accountId: "a", cloudflareToken: "t", fetchImpl, now, retryDelayMs: 0 });
  assert.deepEqual(deleted.sort(), objects.map((object) => object.key).sort());
  assert.ok([...deletes.values()].every((count) => count === 2));
});
