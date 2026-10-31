import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const { cliReleaseChannelOf, cliReleaseSupersedes, parseMachineCliUpdateStatus } =
  await loadTypescriptModule(new URL("../src/cli-release.ts", import.meta.url));

test("a daemon's CLI update status is read only when it says what is happening", () => {
  const at = "2026-10-31T14:00:00.000Z";
  assert.deepEqual(parseMachineCliUpdateStatus({ state: "checking", at }), { state: "checking", at });
  assert.deepEqual(parseMachineCliUpdateStatus({ state: "installing", version: "2.3.1", at }),
    { state: "installing", version: "2.3.1", at });
  assert.deepEqual(parseMachineCliUpdateStatus({ state: "failed", error: " feed down ", at }),
    { state: "failed", error: "feed down", at });
  // A failure without its reason, an unknown state or a missing time is not a status.
  assert.equal(parseMachineCliUpdateStatus({ state: "failed", at }), undefined);
  assert.equal(parseMachineCliUpdateStatus({ state: "waiting", at }), undefined);
  assert.equal(parseMachineCliUpdateStatus({ state: "current" }), undefined);
  assert.equal(parseMachineCliUpdateStatus("current"), undefined);
});

test("a version names its channel", () => {
  assert.equal(cliReleaseChannelOf("2.3.0"), "stable");
  assert.equal(cliReleaseChannelOf("v2.3.0+abc"), "stable");
  assert.equal(cliReleaseChannelOf("2.2.1-beta.20"), "dev");
  assert.equal(cliReleaseChannelOf("dev"), undefined);
  assert.equal(cliReleaseChannelOf("2.3"), undefined);
});

test("a newer release supersedes an older one on its own channel only", () => {
  assert.equal(cliReleaseSupersedes("2.3.0", "2.2.0"), true);
  assert.equal(cliReleaseSupersedes("2.3.0", "2.3.0"), false);
  assert.equal(cliReleaseSupersedes("2.3.0", "2.10.0"), false);
  assert.equal(cliReleaseSupersedes("2.2.1-beta.20", "2.2.1-beta.9"), true);
  assert.equal(cliReleaseSupersedes("2.2.1-beta.20", "2.1.1-beta.23"), true);
  assert.equal(cliReleaseSupersedes("2.2.1-beta.20", "2.2.1-beta.20"), false);
  // A stable release never moves a beta, nor a beta a stable build.
  assert.equal(cliReleaseSupersedes("2.3.0", "2.2.1-beta.20"), false);
  assert.equal(cliReleaseSupersedes("2.2.1-beta.20", "2.2.0"), false);
  assert.equal(cliReleaseSupersedes("garbage", "2.2.0"), false);
});
