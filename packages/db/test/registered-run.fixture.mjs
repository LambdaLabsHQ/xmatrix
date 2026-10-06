// Query rows that admit a Run under its Space Agent Registration, for tests
// that mock the database. Every Run executes under a registration binding;
// these are the binding, the registration's current grant and policy, and the
// Channel capability the admission checks. Returns undefined for any other
// query so a test's own mock answers it.
const NO_RESOURCES = { workspaces: [], models: [], capabilities: [] };

export function registeredRunRows(query, {
  runId = "run-1", spaceId = "space-1", channelId = "channel-1", ownerUserId = "owner-1",
  actorUserId = ownerUserId, machineId = "machine-1", harness = "codex", channelCapability = true,
} = {}) {
  const resources = NO_RESOURCES;
  if (query.name === "run_registration_access_binding_v3" || query.name === "run_registration_access_binding_check_v1") {
    return [{ run_id: runId, space_id: spaceId, owner_user_id: ownerUserId, machine_id: machineId, harness,
      actor_user_id: actorUserId, allocation_id: `allocation:${runId}`, authorization_digest: "a".repeat(64),
      grant_revision: 1, grant_execution_revision: 1, policy_revision: 1, policy_execution_revision: 1,
      requested_json: resources }];
  }
  if (query.name === "registration_admission_members_v2" || query.name === "registration_admission_members_check_v1") {
    return [...new Set([ownerUserId, actorUserId])].map(userId => ({ user_id: userId, role: "owner" }));
  }
  if (query.name === "registration_admission_access_v1" || query.name === "registration_admission_access_check_v1") {
    return [{ space_id: spaceId, owner_user_id: ownerUserId, machine_id: machineId, harness,
      grant_state: "active", grant_revision: 1, grant_execution_revision: 1, grant_limits: resources,
      policy_state: "enabled", policy_revision: 1, policy_execution_revision: 1, policy_limits: resources }];
  }
  if (channelCapability && (query.name === "channel_capability_runtime_continue_v3" ||
      query.name === "channel_capability_runtime_new_work_v3" || query.name === "channel_capability_runtime_check_v3")) {
    return [{ channel_id: channelId, space_id: spaceId, mode: "open", metadata_json: {}, version: 1, archived_at: null }];
  }
  return undefined;
}
