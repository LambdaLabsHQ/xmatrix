import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";
import { sourceOffenders } from "./repository-sources.mjs";

const {
  channelVisibilityScope,
  spaceVisibilityScope,
  uploadScopeCoversRefScope,
} = await loadTypescriptModule(new URL("../src/restricted-content-scope.ts", import.meta.url));

test("a Channel's content is visible to its members when closed, else to its Space", () => {
  assert.equal(spaceVisibilityScope("s1"), "space:s1");
  assert.equal(channelVisibilityScope({ mode: "closed", channelId: "c1", spaceId: "s1" }), "channel:c1");
  assert.equal(channelVisibilityScope({ mode: "open", channelId: "c1", spaceId: "s1" }), "space:s1");
  assert.equal(channelVisibilityScope({ mode: undefined, channelId: "c1", spaceId: "s1" }), "space:s1");
  assert.equal(uploadScopeCoversRefScope("space:s1", "channel:c1", "s1"), true);
  assert.equal(uploadScopeCoversRefScope("space:s2", "channel:c1", "s1"), false);
});

test("no package spells the Channel visibility scope out again", () => {
  const spelled = [
    /"closed"\s*\?\s*`channel:\$\{/u,
    /!==\s*"closed"[^\n]*`space:\$\{/u,
  ];
  const offenders = sourceOffenders(["packages/db/src/", "packages/hub/src/", "apps/web/src/"],
    (source) => spelled.some((pattern) => pattern.test(source)));
  assert.deepEqual(offenders, [], "use channelVisibilityScope / spaceVisibilityScope from @xmatrix/protocol");
});
