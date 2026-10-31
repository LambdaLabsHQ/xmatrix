import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const { cliReleaseChannelOf, cliReleaseSupersedes } =
  await loadTypescriptModule(new URL("../src/cli-release.ts", import.meta.url));

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
