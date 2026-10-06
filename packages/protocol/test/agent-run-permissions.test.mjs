import assert from "node:assert/strict";
import test from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const permissions = await loadTypescriptModule(
  new URL("../src/agent-run-permissions.ts", import.meta.url),
);

test("Agent Run permissions accept only the closed capability catalog", () => {
  assert.deepEqual(
    permissions.parseAgentRunPermissions([
      "channel.attachments.write",
      "channel.attachments.write",
      "admin",
      42,
    ]),
    ["channel.attachments.write"],
  );
  assert.deepEqual(permissions.parseAgentRunPermissions("channel.attachments.write"), []);
  assert.deepEqual(permissions.parseAgentRunPermissions(undefined), []);
});
