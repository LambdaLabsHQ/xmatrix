import assert from "node:assert/strict";
import test from "node:test";

import { PostgresSpaceSecretRepository, SpaceSecretError } from "../dist/space-secret-control.js";
import { encryptSecretValue, encryptSpaceSecretValue } from "../dist/secret-value-control.js";
import { registeredRunRows } from "./registered-run.fixture.mjs";
import { activePlacementRow } from "./recording-database.fixture.mjs";

const material = "test-space-secret-material";
const at = "2026-10-02T08:00:00.000Z";
const run = { runId: "run-1", ownerUserId: "owner-1", spaceId: "space-1", channelId: "channel-1", instanceId: "instance-1",
  executionKey: "execution-1" };

async function secretRow(ref, access, value, overrides = {}) {
  return { space_id: "space-1", secret_ref: ref, env_name: ref.toUpperCase().replace(/-/gu, "_"), description: null,
    access, value_version: 1, value_digest: "digest", created_by_user_id: "owner-1", updated_by_user_id: "owner-1",
    version: 1, created_at: at, updated_at: at,
    encrypted_value_json: await encryptSpaceSecretValue(material, "space-1", ref, 1, value), ...overrides };
}

/** A Space with `secrets` rows and `approvals` (secret refs approved for run-1). */
function database({ secrets = [], approvals = [], roles = { "owner-1": "member", "admin-1": "admin" },
  live = {}, overrides = {} } = {}) {
  const calls = [];
  const respond = (query) => {
    if (Object.hasOwn(overrides, query.name)) return overrides[query.name];
    const registered = registeredRunRows(query);
    if (registered) return registered;
    switch (query.name) {
      case "channel_capability_secret_new_work_v3":
      case "channel_capability_secret_run_read_v3": return [{ channel_id: "channel-1", space_id: "space-1",
        mode: "open", role: "owner", archived_at: null, metadata_json: {}, explicit_access: false }];
      case "space_secret_live_run_read_v2":
      case "space_secret_live_run_write_v2": return [{ owner_user_id: "owner-1", channel_id: "channel-1",
        run_status: "running", execution_key: "execution-1", instance_channel_id: "channel-1",
        instance_status: "online", ...live }];
      case "space_secret_member_role_v1": return roles[query.values[1]] ? [{ role: roles[query.values[1]] }] : [];
      case "space_secret_run_views_v1": return secrets
        .filter((row) => !query.values[2] || query.values[2].includes(row.secret_ref))
        .map((row) => ({ ...row, readable: row.access === "auto" || approvals.includes(row.secret_ref) }));
      case "space_secret_write_read_v1":
      case "space_secret_approve_read_v1": return secrets.filter((row) => row.secret_ref === query.values[1]);
      case "space_secret_list_v1": return secrets;
      case "space_secret_write_count_v1": return [{ count: secrets.length }];
      case "space_secret_insert_v1": return [{ space_id: query.values[0], secret_ref: query.values[1],
        env_name: query.values[2], description: query.values[3], access: query.values[4],
        created_by_user_id: query.values[8], created_at: at, updated_at: at }];
      case "space_placement_resolve_v1": return [activePlacementRow(query.values[0], { planClass: "default" })];
      case "channel_space_directory_resolve_v2": return [{ channel_id: query.values[0], space_id: "space-1",
        shard_id: "shard-0", placement_epoch: 1, entity_version: 1 }];
      case "space_secret_run_channel_v1": return [{}];
      default: return [];
    }
  };
  const contexts = [];
  return { calls, contexts, cacheMode: "disabled", async transaction(context, callback) {
    contexts.push(context);
    return callback({ async query(query) { calls.push(query); return respond(query); } });
  } };
}

const repository = (db) => new PostgresSpaceSecretRepository(db, material);

test("a live Run reads an auto secret at the moment it asks, and the read is audited", async () => {
  const db = database({ secrets: [await secretRow("github", "auto", "gh-value")] });
  const result = await repository(db).runRead(run, ["github"]);
  assert.deepEqual(result.secrets, [{ secretRef: "github", envName: "GITHUB", value: "gh-value" }]);
  const audit = db.calls.find((call) => call.name === "space_secret_run_read_audit_v2");
  assert.ok(audit, "every read is audited");
  assert.equal(audit.text.includes("host_id"), false, "Space scope never occupies a hostname column");
  assert.match(audit.text, /space_id/);
  assert.equal(audit.values.includes("gh-value"), false, "the audit names secrets, never values");
});

test("an ask secret needs a Space admin's approval for this Run; a missing one is named", async () => {
  const rows = [await secretRow("db-url", "ask", "postgres://secret")];
  await assert.rejects(repository(database({ secrets: rows })).runRead(run, ["db-url"]),
    (error) => error instanceof SpaceSecretError && error.code === "secret_approval_required" && error.status === 403);
  const approved = await repository(database({ secrets: rows, approvals: ["db-url"] })).runRead(run, ["db-url"]);
  assert.equal(approved.secrets[0].value, "postgres://secret");
  await assert.rejects(repository(database({ secrets: rows })).runRead(run, ["absent"]),
    (error) => error.code === "secret_not_found" && error.status === 404);
});

test("naming no secret reads only those the Run may read now", async () => {
  const db = database({ secrets: [await secretRow("open-key", "auto", "open"),
    await secretRow("closed-key", "ask", "closed")] });
  const result = await repository(db).runRead(run);
  assert.deepEqual(result.secrets.map((secret) => secret.secretRef), ["open-key"]);
  const listed = await repository(db).runList(run);
  assert.deepEqual(listed.secrets.map(({ secretRef, readable }) => [secretRef, readable]),
    [["open-key", true], ["closed-key", false]]);
  assert.equal(JSON.stringify(listed).includes("open"), true);
  assert.equal(JSON.stringify(listed).includes("\"value\""), false, "listing reads no value");
});

test("reads recheck the live Run, its execution key, registration and the owner's membership", async () => {
  const rows = [await secretRow("github", "auto", "gh-value")];
  for (const scenario of [{ live: { run_status: "stopped" } }, { live: { instance_status: "offline" } },
    { live: { execution_key: "stale" } }, { live: { owner_user_id: "someone-else" } },
    { overrides: { run_registration_access_binding_check_v1: [] } },
    { roles: { "owner-1": "participant" } }, { roles: {} }]) {
    const db = database({ secrets: rows, ...scenario });
    await assert.rejects(repository(db).runRead(run, ["github"]));
    assert.equal(db.calls.some((call) => call.name === "space_secret_run_views_v1"), false,
      `${JSON.stringify(scenario)} refuses before any secret is read`);
  }
});

test("secrets are read on the Space's own shard, and only for the Space the Run's token names", async () => {
  const db = database({ secrets: [await secretRow("github", "auto", "gh-value")] });
  await repository(db).runRead(run, ["github"]);
  const placed = db.contexts.filter((context) => context.placement);
  assert.equal(placed.length, 1);
  assert.deepEqual(placed[0].placement, { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 });
  const elsewhere = database({ secrets: [await secretRow("github", "auto", "gh-value")] });
  await assert.rejects(repository(elsewhere).runRead({ ...run, spaceId: "space-2" }, ["github"]),
    (error) => error.code === "request_context_mismatch");
  assert.equal(elsewhere.calls.some((call) => call.name === "space_secret_run_views_v1"), false);
  const card = database({ secrets: [await secretRow("github", "ask", "gh-value")] });
  await repository(card).approve({ userId: "admin-1", runId: "run-1", channelId: "channel-1", secretRef: "github" });
  assert.deepEqual(card.contexts.find((context) => context.placement).placement.spaceId, "space-1",
    "a card is answered on the shard of its Channel's Space");
});

test("a secret moved from an owner's catalog keeps its owner binding until it is next set", async () => {
  const legacy = await secretRow("legacy", "auto", "unused", {
    encrypted_value_json: await encryptSecretValue(material, "owner-1", "legacy", 3, "legacy-value"), value_version: 3 });
  const result = await repository(database({ secrets: [legacy] })).runRead(run, ["legacy"]);
  assert.equal(result.secrets[0].value, "legacy-value");
  const moved = { ...legacy, created_by_user_id: "another-owner" };
  await assert.rejects(repository(database({ secrets: [moved] })).runRead(run, ["legacy"]),
    (error) => error.code === "secret_authority_corrupt", "a ciphertext bound elsewhere does not decrypt");
});

test("an Agent saves a credential it holds as ask, approved for itself, and cannot replace one", async () => {
  const db = database();
  const { secret } = await repository(db).runCreate(run, { secretRef: "agent-key", value: "agent-known-value" });
  assert.equal(secret.access, "ask");
  assert.equal(db.calls.some((call) => call.values?.includes("agent-known-value")), false, "the value is stored encrypted");
  const approval = db.calls.find((call) => call.name === "space_secret_approve_run_v1");
  assert.deepEqual(approval.values.slice(0, 3), ["run-1", "agent-key", "space-1"]);
  const existing = database({ secrets: [await secretRow("agent-key", "auto", "kept")] });
  await assert.rejects(repository(existing).runCreate(run, { secretRef: "agent-key", value: "other" }),
    (error) => error.code === "secret_already_exists");
  assert.equal(existing.calls.some((call) => /space_secret_(insert|update)_v1/u.test(call.name)), false);
});

test("only Space admins save, delete or approve; members list aliases without values", async () => {
  const rows = [await secretRow("github", "ask", "gh-value")];
  for (const action of [
    (repo) => repo.put({ spaceId: "space-1", userId: "owner-1", secretRef: "new", value: "v" }),
    (repo) => repo.remove({ spaceId: "space-1", userId: "owner-1", secretRef: "github" }),
    (repo) => repo.approve({ userId: "owner-1", runId: "run-1", channelId: "channel-1", secretRef: "github" }),
  ]) await assert.rejects(action(repository(database({ secrets: rows }))), (error) => error.code === "forbidden");
  const listed = await repository(database({ secrets: rows })).list({ spaceId: "space-1", userId: "owner-1" });
  assert.equal(listed.canManage, false);
  assert.deepEqual(Object.keys(listed.secrets[0]).sort(),
    ["access", "createdAt", "createdByUserId", "envName", "secretRef", "updatedAt"]);
  await assert.rejects(repository(database({ secrets: rows, roles: {} })).list({ spaceId: "space-1", userId: "stranger" }),
    (error) => error.code === "forbidden");
});

test("an admin approving a held secret lets that Run read it without rewriting the secret", async () => {
  const db = database({ secrets: [await secretRow("github", "ask", "gh-value")] });
  await repository(db).approve({ userId: "admin-1", runId: "run-1", channelId: "channel-1", secretRef: "github",
    envName: "OTHER_NAME" });
  assert.equal(db.calls.some((call) => call.name === "space_secret_approve_run_v1"), true);
  assert.equal(db.calls.some((call) => /space_secret_(insert|update)_v1/u.test(call.name)), false,
    "approving alone keeps the secret's settings");
  await assert.rejects(repository(database()).approve({ userId: "admin-1", runId: "run-1", channelId: "channel-1",
    secretRef: "absent" }), (error) => error.code === "secret_value_required");
});

test("a new secret needs a value and starts as ask", async () => {
  await assert.rejects(repository(database()).put({ spaceId: "space-1", userId: "admin-1", secretRef: "new" }),
    (error) => error.code === "secret_value_required");
  const db = database();
  const { secret } = await repository(db).put({ spaceId: "space-1", userId: "admin-1", secretRef: "new-key", value: "v" });
  assert.equal(secret.access, "ask");
  assert.equal(secret.envName, "NEW_KEY");
  await assert.rejects(repository(database()).put({ spaceId: "space-1", userId: "admin-1", secretRef: "x", value: "v",
    access: "always" }), (error) => error.code === "invalid_request");
});

test("Space secrets refuse cached PostgreSQL", () => {
  assert.throws(() => new PostgresSpaceSecretRepository({ cacheMode: "cached" }, material),
    (error) => error instanceof SpaceSecretError && error.code === "cached_authority_forbidden");
});
