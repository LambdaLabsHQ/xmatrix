import assert from "node:assert/strict";
import { test } from "node:test";
import * as protocol from "@xmatrix/protocol";
import * as appConnectors from "../src/app-connectors.ts";
import * as subscriptionDomain from "../src/github-subscription-domain.ts";
import { ControlError } from "../../db/src/control-error.ts";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { githubAppEnv, githubConnection, jsonResponse, stubGitHubFetch } from "./support/github-app.mjs";

// A GitHub command as its Channel sees it: the real GitHub connector against a
// stubbed GitHub, and the receipt the Hub would append in reply.
async function receiptFor(body, github) {
  const receipts = [], finalized = [];
  const apps = {
    appCommand: async (_env, command, input) => { if (command === "finalize-execution") finalized.push(input); },
    usableAppConnections: async () => [githubConnection()],
    listAppSourceRelations: async () => [],
    CONNECTED_APPS_NEED_MEMBER: "members only",
  };
  const support = await loadCommonJsSourceModule(new URL("../src/connectors/command-support.ts", import.meta.url), name => {
    if (name === "@xmatrix/protocol") return protocol;
    if (name === "@xmatrix/db") return { ControlError };
    if (name === "../product-message-append") return {
      dispatchProductMessageAppend: async (_env, _channel, input) => { receipts.push(input); return new Response(null, { status: 200 }); },
    };
    return {};
  });
  const adapter = await loadCommonJsSourceModule(
    new URL("../src/product-github-connector-authority-adapter.ts", import.meta.url), name => ({
      "@xmatrix/protocol": protocol,
      "./app-connectors": appConnectors,
      "./apps": apps,
      "./spaces": { getChannel: async () => ({ channel: { spaceId: "space-1" } }) },
      "./connectors/connector-commands": { connectionActionRefusal: async () => undefined },
      "./connectors/command-support": support,
      "./github-subscription-domain": subscriptionDomain,
    })[name] ?? assert.fail(`unexpected import ${name}`));
  const stub = stubGitHubFetch(github);
  try {
    await adapter.dispatchProductGitHubConnectorAfterAuthorityMessage({ env: await githubAppEnv(), channelId: "channel-1",
      messageId: "message-1", actorUserId: "owner", body });
  } finally { stub.restore(); }
  assert.equal(receipts.length, 1);
  return { receipt: receipts[0], finalized };
}

test("a repository whose installation this Space has not linked says who links it where, and offers that on a card", async () => {
  // GitHub knows the App on OtherOrg (installation 999); the Space links only 777.
  const { receipt, finalized } = await receiptFor("@github:subscribe:OtherOrg/secrets\n@github:subscribe:OtherOrg/more",
    call => call.url.endsWith("/installation") ? jsonResponse({ id: 999 }) : jsonResponse({}, 500));
  const [entry, second] = protocol.parseConnectorReceipt(receipt.body);
  assert.equal(entry.status, "failed");
  assert.match(entry.detail, /OtherOrg\/secrets/u, "names the repository");
  assert.match(entry.detail, /Space admin .*Apps → GitHub.*links OtherOrg/u, "says who acts, where, and on which account");
  assert.match(entry.detail, /github\.com alone does not link/u, "says why installing on GitHub was not enough");
  assert.match(second.detail, /OtherOrg\/more/u);
  assert.deepEqual(protocol.connectorReceiptFixesOf(receipt.residual.appMetadata),
    [{ providerId: "github", actionId: "subscribe", remedy: { kind: "reconnect" } }],
    "the receipt carries one reconnect fix, which draws its settings card");
  assert.deepEqual(finalized.map(input => input.reason),
    ["github_installation_not_linked_to_space", "github_installation_not_linked_to_space"],
    "the execution keeps the machine code");
});

test("a repository the App is not installed on is explained without offering to connect again", async () => {
  const { receipt } = await receiptFor("@github:subscribe:LambdaLabsHQ/typo",
    call => call.url.endsWith("/installation") ? jsonResponse({ message: "Not Found" }, 404) : jsonResponse({}, 500));
  const [entry] = protocol.parseConnectorReceipt(receipt.body);
  assert.equal(entry.status, "failed");
  assert.match(entry.detail, /not installed on LambdaLabsHQ\/typo, or that repository does not exist/u);
  assert.deepEqual(protocol.connectorReceiptFixesOf(receipt.residual.appMetadata), []);
});
