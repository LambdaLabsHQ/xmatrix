import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { HUB_ENVIRONMENT_DOC, renderHubEnvironmentDoc } from "../scripts/hub-environment-doc.ts";

test("docs/operations/hub-environment.md matches the Hub environment catalog", async () => {
  assert.equal(
    await readFile(HUB_ENVIRONMENT_DOC, "utf8"),
    renderHubEnvironmentDoc(),
    "run `pnpm --filter @xmatrix/hub env:doc` and commit the result",
  );
});
