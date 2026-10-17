import assert from "node:assert/strict";
import { test } from "node:test";
import * as db from "@xmatrix/db";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

// Two Spaces' Slack bindings of one workspace that predate one Space per
// workspace share its bot: neither Space acts with it until one disconnects,
// so a post cannot reach a private channel the bot joined for the other.
test("credentials of a Slack workspace still shared by two Spaces are refused for use", async () => {
  const resolved = (workspaceShared) => ({ status: "configured", version: 1, values: { botToken: "shared-bot" },
    oauthGrant: { grantGeneration: "grant", workspaceShared } });
  let answer;
  const credentials = await loadCommonJsSourceModule(new URL("../src/connectors/connection-credentials.ts", import.meta.url),
    (name) => ({
      "@xmatrix/db": db,
      "./credentials": { connectorCredentialRepository: () => ({ resolve: async () => answer }) },
      "./oauth": { refreshOAuthFields: async () => undefined, oauthClient: () => undefined },
      "../app-connectors": { getAppConnectorProvider: () => ({ id: "slack" }) },
    })[name] ?? {});
  answer = resolved(true);
  await assert.rejects(credentials.connectionCredentials({}, "space-b", "slack"),
    (error) => error.code === db.SLACK_WORKSPACE_TAKEN && error.status === 409);
  answer = resolved(false);
  assert.equal((await credentials.connectionCredentials({}, "space-a", "slack")).botToken, "shared-bot");
});
