import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchLatestVersion,
  latestVersionFromBody,
  latestVersionUrl,
  watchHarnessReleases,
} from "../src/harness-release-watch.ts";

const npm = { id: "claude", management: { latest: { kind: "npm", package: "@anthropic-ai/claude-code" } } };
const pypi = { id: "vibe", management: { latest: { kind: "pypi", package: "mistral-vibe" } } };
const unpublished = { id: "cursor", management: {} };
/** A daemon the read names for a preset. */
const target = (presetId, owner = "owner") => ({ presetId, ownerUserId: owner, ownerEmail: `${owner}@example.test`,
  machineId: "machine", hostId: "host", daemonId: `daemon-${owner}` });

/** One pass over npm, PyPI and an unpublished preset; records each target read and command. */
async function watchAll(latest, found) {
  const asked = [];
  const commands = [];
  const result = await watchHarnessReleases({}, {
    presets: [npm, pypi, unpublished],
    latest,
    targets: async (releases) => { asked.push(releases); return found(releases); },
    issue: async (command) => { commands.push(command); return { command: { id: command.controlId } }; },
  });
  return { result, asked, commands };
}

test("registry reads use the official endpoints and accept only bounded version strings", () => {
  assert.equal(latestVersionUrl(npm.management.latest),
    "https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest");
  assert.equal(latestVersionUrl(pypi.management.latest), "https://pypi.org/pypi/mistral-vibe/json");
  assert.equal(latestVersionUrl({ kind: "npm", package: "../evil" }), undefined);
  assert.equal(latestVersionUrl({ kind: "npm", package: "Bad Name" }), undefined);
  assert.equal(latestVersionFromBody("npm", { version: "2.1.289" }), "2.1.289");
  assert.equal(latestVersionFromBody("pypi", { info: { version: "2.25.8" } }), "2.25.8");
  assert.equal(latestVersionFromBody("npm", { version: "1.0.0\n" }), undefined);
  assert.equal(latestVersionFromBody("npm", { version: 3 }), undefined);
  assert.equal(latestVersionFromBody("pypi", { version: "1.0.0" }), undefined);
});

test("a large registry document is read, but one past the bound is refused", async () => {
  const body = (size) => JSON.stringify({ readme: "x".repeat(size), version: "1.2.3" });
  const fetcher = (size) => async () => new Response(body(size));
  assert.equal(await fetchLatestVersion(npm.management.latest, fetcher(200 * 1024)), "1.2.3");
  assert.equal(await fetchLatestVersion(npm.management.latest, fetcher(2 * 1024 * 1024)), undefined);
  assert.equal(await fetchLatestVersion(npm.management.latest, async () => new Response("", { status: 503 })), undefined);
  assert.equal(await fetchLatestVersion(npm.management.latest, async () => { throw new Error("offline"); }), undefined);
});

test("each daemon that has not seen the latest version is told the preset, never a version", async () => {
  const { result, asked, commands } = await watchAll(
    async (latest) => latest.kind === "npm" ? "2.1.289" : undefined, () => [target("claude")]);
  assert.deepEqual(result, { issued: 1 });
  assert.deepEqual(asked, [[{ presetId: "claude", version: "2.1.289" }]],
    "an unreadable registry and an unpublished preset tell nobody");
  assert.equal(commands[0].commandType, "harness_action");
  assert.equal(commands[0].principal.id, "owner");
  assert.deepEqual(Object.keys(commands[0].payload).sort(), ["action", "presetId", "requestId", "type"]);
  assert.equal(commands[0].payload.action, "release");
  assert.equal(commands[0].payload.presetId, "claude");
  assert.equal(commands[0].controlId, commands[0].payload.requestId);
});

test("one refused notice does not stop the others", async () => {
  let calls = 0;
  const result = await watchHarnessReleases({}, {
    presets: [npm],
    latest: async () => "2.1.289",
    targets: async () => ["a", "b"].map(owner => target("claude", owner)),
    issue: async () => {
      calls++;
      if (calls === 1) throw new Error("authority unavailable");
      return {};
    },
  });
  assert.deepEqual(result, { issued: 1 });
});

test("every preset with a published version is read in one pass, each target told its own preset", async () => {
  const { result, asked, commands } = await watchAll(
    async (latest) => latest.kind === "npm" ? "2.1.289" : "2.25.8",
    (releases) => releases.map(({ presetId }) => target(presetId)));
  assert.deepEqual(result, { issued: 2 });
  assert.deepEqual(asked, [[{ presetId: "claude", version: "2.1.289" }, { presetId: "vibe", version: "2.25.8" }]]);
  assert.deepEqual(commands.map(command => command.payload.presetId), ["claude", "vibe"]);
});

test("a pass with no readable registry reads no targets", async () => {
  let read = false;
  const result = await watchHarnessReleases({}, {
    presets: [npm, pypi],
    latest: async () => undefined,
    targets: async () => { read = true; return []; },
  });
  assert.deepEqual(result, { issued: 0 });
  assert.equal(read, false);
});
