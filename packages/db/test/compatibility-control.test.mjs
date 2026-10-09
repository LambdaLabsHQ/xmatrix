import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresAppRepository,
  PostgresSlackOAuthRepository,
} from "../dist/index.js";
import { decryptSecretValue } from "../dist/secret-value-control.js";
import { activePlacementRow, recordingDatabase } from "./recording-database.fixture.mjs";

function database(respond) {
  return recordingDatabase((query) => query.name === "space_placement_resolve_v1"
    ? [activePlacementRow(query.values[0], { shardId: "test-shard", planClass: "standard" })] : respond(query));
}

const material = "compatibility-test-material";
const grantId = "123e4567-e89b-42d3-a456-426614174000";
const state = `${grantId}.${"a".repeat(64)}`;

test("Slack approval keeps its token encrypted on the session until it is consumed", async () => {
  const session = { grant_id: grantId, oauth_state: state, owner_user_id: "user-1",
    status: "pending", interval_seconds: 2, secret_ref: null, token_json: null, team_name: null, version: 1,
    start_command_id: "start-1", approve_command_id: null,
    created_at: "2026-08-30T08:00:00.000Z", updated_at: "2026-08-30T08:00:00.000Z",
    expires_at: "2099-08-30T08:10:00.000Z" };
  const db = database((query) => query.name === "slack_oauth_session_lock_v1" ? [session] : []);
  const repository = new PostgresSlackOAuthRepository(db, material);
  const result = await repository.approve({
    commandId: "approve-1", state, ownerUserId: "user-1", slackToken: "xoxp-plaintext-token", team: "Team",
  });
  assert.deepEqual(result, { ok: true, team: "Team" });
  const approval = db.calls.find((call) => call.name === "slack_oauth_approve_v2");
  assert.ok(approval);
  assert.equal(db.calls.some((call) => call.values?.includes("xoxp-plaintext-token")), false);
  assert.equal(db.calls.some((call) => /secret_(values|catalog)/u.test(call.text ?? "")), false,
    "an owner's personal secret catalog is not used");
  const sealed = JSON.parse(approval.values[2]);
  const decrypted = await decryptSecretValue(material, { owner_user_id: "user-1",
    secret_ref: `internal/oauth/slack/${grantId}`, authority_version: 1, encrypted_value_json: sealed });
  assert.equal(decrypted, "xoxp-plaintext-token");
  await assert.rejects(repository.approve({ commandId: "approve-2", state, ownerUserId: "user-1" }),
    (error) => error.code === "slack_oauth_exchange_required");
  await assert.rejects(repository.approve({ commandId: "approve-3", state, ownerUserId: "someone-else",
    slackToken: "xoxp-other-token" }), (error) => error.code === "slack_oauth_not_found");

  const approved = { ...session, status: "approved", secret_ref: `internal/oauth/slack/${grantId}`,
    token_json: sealed, team_name: "Team" };
  const consumed = database((query) => query.name === "slack_oauth_session_lock_v1" ? [approved] : []);
  const token = await new PostgresSlackOAuthRepository(consumed, material).consume({
    commandId: "consume-1", grantId, ownerUserId: "user-1", principal: { kind: "user", id: "user-1" } });
  assert.deepEqual(token, { status: "approved", slackToken: "xoxp-plaintext-token", team: "Team" });
  assert.match(consumed.calls.find((call) => call.name === "slack_oauth_consume_v2").text, /token_json=NULL/u);
});

test("GitHub webhook routes are derived from PostgreSQL connector relations", async () => {
  const db = database((query) => query.name === "app_github_subscription_routes_v6"
    ? [{ relation_id: "imported-repository", space_id: "space-1", channel_id: "channel-1", connection_id: "connection-1",
        created_by: "user-1", created_at: "2026-10-01T00:00:00.000Z", source_kind: "repository",
        source_ref: "github:repo:lambdalabshq/xmatrix" },
      { relation_id: "imported-pull-request", space_id: "space-1", channel_id: "channel-2", connection_id: "connection-1",
        created_by: "user-2", created_at: "2026-10-08T00:00:00.000Z", source_kind: "issue",
        source_ref: "github:issue:lambdalabshq/xmatrix#7" }]
    : []);
  const routes = await new PostgresAppRepository(db).githubSubscriptionRoutes({
    requestId: "github-routes-1", installationId: "42",
    sourceRefs: ["github:repo:LambdaLabsHQ/XMatrix", "github:issue:LambdaLabsHQ/XMatrix#7"], feature: "pulls", limit: 1001,
  });

  assert.deepEqual(routes, [{ relationId: "imported-repository", installationId: "42", sourceRef: "github:repo:lambdalabshq/xmatrix",
    sourceKind: "repository", createdAt: "2026-10-01T00:00:00.000Z", spaceId: "space-1", channelId: "channel-1",
    connectionId: "connection-1",
    authorityRootUserId: "user-1" }, { relationId: "imported-pull-request", installationId: "42", sourceRef: "github:issue:lambdalabshq/xmatrix#7",
    sourceKind: "issue", createdAt: "2026-10-08T00:00:00.000Z", spaceId: "space-1", channelId: "channel-2",
    connectionId: "connection-1",
    authorityRootUserId: "user-2" }]);
  const query = db.calls.find((call) => call.name === "app_github_subscription_routes_v6");
  assert.deepEqual(query.values, ["42",
    ["github:repo:lambdalabshq/xmatrix", "github:issue:lambdalabshq/xmatrix#7"], 1001, "pulls"]);
  assert.match(query.text, /features_json \? \$4/u, "an event nobody subscribed to finds no route");
  assert.doesNotMatch(query.text, /archived_at/u, "a once-archived conversation still receives webhooks");
});
