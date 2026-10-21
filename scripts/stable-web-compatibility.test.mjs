import assert from "node:assert/strict";
import { test } from "node:test";

import { stableWebRefusal, webRelease } from "./stable-web-compatibility.mjs";

const policy = { protocolVersion: 2, minimumVersions: { app: "1.3.0" } };

test("a beta Hub deploys only while its client policy admits the live stable Web", () => {
  assert.equal(stableWebRefusal(policy, { version: "1.3.0", protocolVersion: 2 }), null);
  assert.equal(stableWebRefusal(policy, { version: "1.3.1-beta.6", protocolVersion: 2 }), null);
  assert.match(stableWebRefusal({ ...policy, protocolVersion: 3 }, { version: "1.3.0", protocolVersion: 2 }),
    /protocol 3, the stable Web 1\.3\.0 speaks 2/u);
  // A beta of the minimum's version precedes it, as the Hub's own comparison holds.
  assert.match(stableWebRefusal({ ...policy, minimumVersions: { app: "1.3.1" } }, { version: "1.3.1-beta.6", protocolVersion: 2 }),
    /requires Web 1\.3\.1 or newer/u);
});

test("the live stable Web is read back to exactly one release and the protocol it was built with", () => {
  const sha = "a".repeat(40);
  const git = (tags) => (args) => args[0] === "tag" ? tags : JSON.stringify({ protocolVersion: 2 });
  assert.deepEqual(webRelease(sha, git("cli-v1.3.0\nxmatrix-v1.3.0\n")), { version: "1.3.0", protocolVersion: 2 });
  assert.throws(() => webRelease(sha, git("")), /not exactly one release tag/u);
  assert.throws(() => webRelease(sha, git("xmatrix-v1.3.0\nxmatrix-v1.3.1-beta.1\n")), /not exactly one release tag/u);
  assert.throws(() => webRelease("not-a-commit", git("xmatrix-v1.3.0\n")), /is not a commit/u);
});
