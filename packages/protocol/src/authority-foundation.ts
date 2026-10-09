import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "./app-connector-manifests.js";
export const DEFAULT_HUB_URL = "https://xmatrix-hub.xmatrix.sh";

export * from "./agent-status-tags.js";
import type { AgentStatusChip } from "./agent-status-tags.js";
import type {
  AgentSkill,
  AppConnectorCompletionDynamicSource,
  ChannelAppMention,
  EvalExpression,
  LlmUsage,
} from "./authority-runtime.js";

import { AGENT_PRESETS, agentPresetForLauncher } from "./agent-presets.js";

export {
  AGENT_PRESETS,
  agentHarnessSpec,
  agentLaunchExecutable,
  withMachineSpawnHarness,
  agentPresetAvatarUrl,
  agentPresetById,
  agentPresetForLauncher,
  normalizeAgentPresetRuntime,
  type AgentHarnessSpec,
  type AgentPreset,
  type AgentPresetBackend,
  type AgentPresetId,
} from "./agent-presets.js";

export function agentAvatarUrlFromMetadata(
  metadata: Record<string, unknown> | undefined | null,
  agentType?: string | null
): string | undefined {
  const avatarValue = metadataStringValue(metadata, "avatarUrl") ?? metadataStringValue(metadata, "avatar_url");
  if (avatarValue) {
    return avatarValue;
  }

  const candidates = [
    metadataStringValue(metadata, "presetId"),
    metadataStringValue(metadata, "preset_id"),
    metadataStringValue(metadata, "tool"),
    metadataStringValue(metadata, "backend"),
    agentType?.trim(),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    // A shared backend (`acp`, `pty`) names no vendor; only dedicated
    // adapters identify their harness by backend alone.
    const preset =
      agentPresetForLauncher(candidate) ??
      AGENT_PRESETS.find(
        (item) => item.backend === candidate && item.backend !== "acp" && item.backend !== "pty",
      );
    if (preset?.avatarUrl) return preset.avatarUrl;
  }

  return undefined;
}

function metadataStringValue(
  metadata: Record<string, unknown> | undefined | null,
  key: string
): string | undefined {
  if (!metadata || !(key in metadata)) return undefined;
  const value = metadata[key];
  return typeof value === "string" ? value.trim() : undefined;
}

// The Space App connection routes, which the Hub serves under `/api` and the
// web proxy forwards from `/api/xmatrix`.
function appConnectionRoutes<Api extends "/api" | "/api/xmatrix">(api: Api) {
  return {
    space_app_connection: (spaceId: string, providerId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/${encodeURIComponent(providerId)}`,
    space_app_connection_check: (spaceId: string, providerId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/${encodeURIComponent(providerId)}/check`,
    space_app_connection_credentials: (spaceId: string, providerId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/${encodeURIComponent(providerId)}/credentials`,
    space_app_connection_policies: (spaceId: string, providerId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/${encodeURIComponent(providerId)}/policies`,
    space_app_connection_oauth_start: (spaceId: string, providerId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/${encodeURIComponent(providerId)}/oauth/start`,
    space_app_connection_sentry_install: (spaceId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/sentry/install`,
    space_app_connection_wecom_install: (spaceId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/wecom/install`,
    connector_wecom_install_prepare: `${api}/connectors/wecom/install/prepare` as const,
    connector_oauth_complete: `${api}/connectors/oauth/complete` as const,
    space_app_connection_dingtalk_install: (spaceId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/dingtalk/install`,
    connector_dingtalk_install_prepare: `${api}/connectors/dingtalk/install/prepare` as const,
    space_app_connection_google_picker: (spaceId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/google/picker`,
    space_app_connection_teams_link: (spaceId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/teams/link`,
    space_app_connection_googlechat_link: (spaceId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/googlechat/link`,
    space_app_connection_github_installations: (spaceId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/github/installations`,
    space_app_connection_github_installation: (spaceId: string, installationId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/github/installations/${encodeURIComponent(installationId)}`,
    space_app_connection_feishu_link: (spaceId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/feishu/link`,
    space_app_connection_telegram_link: (spaceId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/telegram/link`,
    connector_oauth_providers: `${api}/connectors/oauth/providers` as const,
    space_app_connection_completion: (
      spaceId: string,
      providerId: string,
      source: AppConnectorCompletionDynamicSource,
      channelId: string,
      parent?: string
    ) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-connections/${encodeURIComponent(providerId)}/completion?source=${encodeURIComponent(source)}&channelId=${encodeURIComponent(channelId)}${parent ? `&parent=${encodeURIComponent(parent)}` : ""}`,
    space_app_executions: (spaceId: string) =>
      `${api}/spaces/${encodeURIComponent(spaceId)}/app-executions`,
    github_app_install: (
      spaceId: string,
      options?: { mode?: "add" | "manage" | "install" | "account"; installationId?: string }
    ) => {
      const params = new URLSearchParams({ spaceId });
      if (options?.mode) params.set("mode", options.mode);
      if (options?.installationId) params.set("installationId", options.installationId);
      return `${api}/apps/github/install?${params.toString()}`;
    },
  };
}

export const HUB_ROUTES = {
  login: "/api/auth/cli/login",
  otp_verify: "/api/auth/cli/otp-verify",
  device_start: "/api/auth/cli/device/start",
  device_approve: "/api/auth/cli/device/approve",
  device_token: "/api/auth/cli/device/token",
  exchange_session: "/api/auth/cli/exchange-session",
  refresh: "/api/auth/refresh",
  me: "/api/auth/me",
  me_profile: "/api/me/profile",
  account_deletion: "/api/account-deletion",
  account_deletion_status: "/api/account-deletion/status",
  account_deletion_cancel: "/api/account-deletion/cancel",
  account_deletion_leave: "/api/account-deletion/leave-space",
  me_avatar: "/api/me/avatar",
  /** Unauthenticated read; see human-avatar.ts for why a face is public. */
  human_avatar: (objectPath: string) => `/api/avatars/${objectPath}`,
  /** The Space's GitHub connector authorizes the repos; directories are the caller's own. */
  space_launch_targets: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/launch-targets`,
  space_member_permissions: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/member-permissions`,
  machine_daemons: "/api/machine-daemons",
  /** The owner asks one of their Machines to install, update or reconfigure a harness. */
  machine_harness_actions: "/api/machine-daemons/harness-actions",
  machine_harness_action: (controlId: string) =>
    `/api/machine-daemons/harness-actions/${encodeURIComponent(controlId)}`,
  /** The owner lists and reclaims the git worktrees on one of their Machines. */
  machine_worktree_actions: "/api/machine-daemons/worktree-actions",
  machine_worktree_action: (controlId: string) =>
    `/api/machine-daemons/worktree-actions/${encodeURIComponent(controlId)}`,
  machine_daemon_credentials: "/api/machine-daemon-credentials",
  machine_daemon_migration_fence: "/api/machine-daemon/migration-fence",
  machine_daemon_workspaces: "/api/machine-daemon/workspaces",
  machine_daemon_agent_run_token: "/api/machine-daemon/agent-runs/token",
  machine_daemon_github_repository_token: "/api/machine-daemon/github/repository-token",
  agent_instances: "/api/agent-instances",
  /** An Agent Run saves a credential it holds into its Space. */
  secrets: "/api/secrets",
  run_secrets: "/api/run-secrets",
  connectors_mcp: "/api/connectors/mcp",
  space_secrets: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/secrets`,
  space_secret: (spaceId: string, secretRef: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/secrets/${encodeURIComponent(secretRef)}`,
  secret_requests: "/api/secret-requests",
  secret_request_fulfill: "/api/secret-requests/fulfill",
  secret_request_status: "/api/secret-requests/status",
  daemon_control: "/api/daemon/control",
  daemon_command_lease_renew: "/api/daemon/command-lease/renew",
  daemon_command_admit_authorize: "/api/daemon/command-admit-authorize",
  daemon_control_result: "/api/daemon/control-result",
  daemon_execution_report: "/api/daemon/executions/report",
  daemon_spawn_intents: "/api/daemon/spawn-intents",
  daemon_spawn_result: "/api/daemon/spawn-result",
  automations: "/api/automations",
  automation: (automationId: string) =>
    `/api/automations/${encodeURIComponent(automationId)}`,
  automation_cancel_execution: (automationId: string) =>
    `/api/automations/${encodeURIComponent(automationId)}/cancel-execution`,
  automation_pause: (automationId: string) =>
    `/api/automations/${encodeURIComponent(automationId)}/pause`,
  automation_resume: (automationId: string) =>
    `/api/automations/${encodeURIComponent(automationId)}/resume`,
  agent_instance: (spaceId: string, channelId: string, instanceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/channels/${encodeURIComponent(channelId)}/agent-instances/${encodeURIComponent(instanceId)}`,
  workspaces: "/api/workspaces",
  status: "/api/status",
  relay_v2_client_projection_readiness: "/api/relay-v2/projection/readiness",
  relay_v2_projection_manifest_bootstrap: "/api/relay-v2/projection/manifest/bootstrap",
  relay_v2_projection_manifest_refresh: "/api/relay-v2/projection/manifest/refresh",
  relay_v2_projection_redactions: "/api/relay-v2/projection/redactions",
  relay_v2_projection_root_capability: "/api/relay-v2/projection/root-capability",
  relay_v2_projection_object_capability: "/api/relay-v2/projection/object-capability",
  relay_v2_private_r2: "/api/relay-v2/private-r2",
  spaces: "/api/spaces",
  space: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}`,
  space_restore: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/restore`,
  space_deletions: "/api/space-deletions",
  personal_space: "/api/personal-space",
  setup_intents: "/api/setup-intents",
  setup_intent: (intentId: string) => `/api/setup-intents/${encodeURIComponent(intentId)}`,
  setup_intent_approve: (intentId: string) => `/api/setup-intents/${encodeURIComponent(intentId)}/approve`,
  setup_intent_decline: (intentId: string) => `/api/setup-intents/${encodeURIComponent(intentId)}/decline`,
  setup_intent_machine: (intentId: string) => `/api/setup-intents/${encodeURIComponent(intentId)}/machine`,
  space_billing: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/billing`,
  space_billing_checkout: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/billing/checkout`,
  space_billing_portal: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/billing/portal`,
  space_billing_reconcile: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/billing/reconcile`,
  space_billing_apple: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/billing/apple`,
  space_billing_apple_prepare: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/billing/apple/prepare`,
  space_billing_apple_reconcile: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/billing/apple/reconcile`,
  stripe_billing_webhook: "/api/billing/stripe/webhook",
  /** Starts an Agent session that refreshes one Channel About. */
  space_channel_about: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/channel-about`,
  space_locale_preference: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/locale-preference`,
  space_channel_view_preference: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/channel-view-preference`,
  space_claims: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/claims`,
  space_claim: (spaceId: string, claimId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/claims/${encodeURIComponent(claimId)}`,
  space_members: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/members`,
  space_member: (spaceId: string, userId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`,
  space_invites: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/invites`,
  space_join: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/join`,
  space_join_requests: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/join-requests`,
  channel_transfer_proposals: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/transfer-proposals`,
  machine_name: (machineId: string) => `/api/machines/${encodeURIComponent(machineId)}/name`,
  /** The owner reads one Machine's load history; `range` is one of 1h, 24h, 7d, 30d, 90d. */
  machine_resource_history: (machineId: string) => `/api/machines/${encodeURIComponent(machineId)}/resource-history`,
  machine_auto_assign: (machineId: string) => `/api/machines/${encodeURIComponent(machineId)}/auto-assign`,
  machine: (machineId: string) => `/api/machines/${encodeURIComponent(machineId)}`,
  space_channel_transfers: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/channel-transfers`,
  channel_transfer_ack: (spaceId: string, proposalId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/channel-transfers/${encodeURIComponent(proposalId)}/ack`,
  space_join_request_decide: (spaceId: string, requestId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/join-requests/${encodeURIComponent(requestId)}/decide`,
  space_invite_emails: (spaceId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/invite-emails`,
  space_app_connections: (spaceId: string, channelId?: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/app-connections${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ""}`,
  space_agent_registrations: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/agent-registrations`,
  space_agent_registration_command: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/agent-registrations/commands`,
  space_agent_registration_query: (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/agent-registrations/query`,
  agent_environment_command: "/api/agent-environments/commands",
  agent_environment_query: "/api/agent-environments/query",
  ...appConnectionRoutes("/api"),
  space_invite: (token: string) => `/api/space-invites/${encodeURIComponent(token)}`,
  space_invite_accept: (token: string) =>
    `/api/space-invites/${encodeURIComponent(token)}/accept`,
  channels: "/api/channels",
  channel_catalog_page: "/api/channels/page",
  message_search: "/api/messages/search",
  channel_catalog_resolve: "/api/channels/resolve",
  channel: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}`,
  channel_history: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/history`,
  channel_read: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/read`,
  channel_join: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/join`,
  channel_leave: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/leave`,
  channel_messages: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
  channel_agent_launches: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/agent-launches/query`,
  channel_message_decision_evidence: (channelId: string, messageId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/decision-evidence`,
  agent_launch_retry: (launchId: string) =>
    `/api/agent-launches/${encodeURIComponent(launchId)}/retry`,
  channel_message_launch_anyway: (channelId: string, messageId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/launch-anyway`,
  channel_summon_intent: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/summon-intent`,
  channel_message_launch_choice: (channelId: string, messageId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/launch-choice`,
  channel_message: (channelId: string, messageId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
  channel_message_reactions: (channelId: string, messageId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions`,
  channel_message_attachments: (channelId: string, messageId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/attachments`,
  migrations_slack: "/api/migrations/slack",
  slack_oauth_start: "/api/migrations/slack/oauth/start",
  slack_oauth_approve: "/api/migrations/slack/oauth/approve",
  slack_oauth_token: "/api/migrations/slack/oauth/token",
  slack_oauth_callback: "/api/migrations/slack/oauth/callback",
  observable_events: "/api/observable/events",
  trace_instance_events: (instanceId: string) =>
    `/api/trace/instances/${encodeURIComponent(instanceId)}/events`,
  cross_space_read_requests: "/api/cross-space-read/requests",
  channel_pending_cross_space_reads: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/cross-space-read-grants/pending`,
  cross_space_read_grant: (spaceId: string, grantId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/cross-space-read-grants/${encodeURIComponent(grantId)}`,
  cross_space_read_grant_decision: (spaceId: string, grantId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/cross-space-read-grants/${encodeURIComponent(grantId)}/decision`,
  observable_client_metrics: "/api/observable/client-metrics",
  context_feed: "/api/context/feed",
  assistant_memory: "/api/assistant-memory",
  shared_memory: "/api/shared-memory",
  channel_annotations: (channelId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/annotations`,
  channel_annotation: (channelId: string, annotationId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/annotations/${encodeURIComponent(annotationId)}`,
  /** Pages (docs/design/pages-and-conversations.md): the tree and everything under one page. */
  space_pages: (spaceId: string, subpath = "") =>
    `/api/spaces/${encodeURIComponent(spaceId)}/pages${subpath ? `/${subpath}` : ""}`,
  space_page_migration: (spaceId: string, subpath = "") =>
    `/api/spaces/${encodeURIComponent(spaceId)}/page-migration${subpath ? `/${subpath}` : ""}`,
  space_governance: (spaceId: string, subpath = "") =>
    `/api/spaces/${encodeURIComponent(spaceId)}/governance${subpath ? `/${subpath}` : ""}`,
  space_page_links: (spaceId: string, subpath = "") =>
    `/api/spaces/${encodeURIComponent(spaceId)}/page-links${subpath ? `/${subpath}` : ""}`,
} as const;

export const WEB_PROXY_ROUTES = {
  space_pages: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/pages`,
  space_page: (spaceId: string, pageId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`,
  space_page_history: (spaceId: string, pageId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}/history`,
  space_page_read: (spaceId: string, pageId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}/read`,
  space_page_live: (spaceId: string, pageId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}/live`,
  space_page_promote: (spaceId: string, pageId: string, revision: number) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}/revisions/${revision}/promote`,
  space_page_links: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/page-links`,
  space_page_migration: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/page-migration`,
  space_governance: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/governance`,
  login: "/api/xmatrix/login",
  otp_verify: "/api/xmatrix/otp-verify",
  cli_exchange_session: "/api/xmatrix/cli/exchange-session",
  cli_device_start: "/api/xmatrix/cli/device/start",
  cli_device_token: "/api/xmatrix/cli/device/token",
  native_session: "/api/xmatrix/native-session",
  me: "/api/xmatrix/me",
  me_profile: "/api/xmatrix/me/profile",
  account_deletion: "/api/xmatrix/account-deletion",
  account_deletion_status: "/api/xmatrix/account-deletion/status",
  account_deletion_cancel: "/api/xmatrix/account-deletion/cancel",
  account_deletion_leave: "/api/xmatrix/account-deletion/leave-space",
  me_avatar: "/api/xmatrix/me/avatar",
  machine_daemons: "/api/xmatrix/machine-daemons",
  agent_instances: "/api/xmatrix/agent-instances",
  daemon_control: "/api/xmatrix/daemon/control",
  daemon_control_result: "/api/xmatrix/daemon/control-result",
  daemon_execution_report: "/api/xmatrix/daemon/executions/report",
  space_secrets: (spaceId: string, secretRef?: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/secrets${
    secretRef ? `/${encodeURIComponent(secretRef)}` : ""}`,
  secret_request_fulfill: "/api/secret-requests/fulfill",
  secret_request_status: "/api/secret-requests/status",
  automations: "/api/xmatrix/automations",
  automation: (automationId: string) =>
    `/api/xmatrix/automations/${encodeURIComponent(automationId)}`,
  automation_pause: (automationId: string) =>
    `/api/xmatrix/automations/${encodeURIComponent(automationId)}/pause`,
  automation_resume: (automationId: string) =>
    `/api/xmatrix/automations/${encodeURIComponent(automationId)}/resume`,
  agent_instance: (spaceId: string, channelId: string, instanceId: string) =>
    `/api/xmatrix/agent-instances/${encodeURIComponent(instanceId)}?spaceId=${encodeURIComponent(spaceId)}&channelId=${encodeURIComponent(channelId)}`,
  channel_agent_launches: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/agent-launches/query`,
  channel_message_decision_evidence: (channelId: string, messageId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/decision-evidence`,
  agent_launch_retry: (launchId: string) =>
    `/api/xmatrix/agent-launches/${encodeURIComponent(launchId)}/retry`,
  channel_message_launch_anyway: (channelId: string, messageId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/launch-anyway`,
  channel_summon_intent: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/summon-intent`,
  channel_message_launch_choice: (channelId: string, messageId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/launch-choice`,
  space_launch_targets: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/launch-targets`,
  workspaces: "/api/xmatrix/workspaces",
  status: "/api/xmatrix/status",
  relay_v2_client_projection_readiness:
    "/api/xmatrix/relay-v2/projection/readiness",
  relay_v2_projection_manifest_bootstrap:
    "/api/xmatrix/relay-v2/projection/manifest/bootstrap",
  relay_v2_projection_manifest_refresh:
    "/api/xmatrix/relay-v2/projection/manifest/refresh",
  relay_v2_projection_redactions: "/api/xmatrix/relay-v2/projection/redactions",
  relay_v2_projection_root_capability:
    "/api/xmatrix/relay-v2/projection/root-capability",
  relay_v2_projection_object_capability:
    "/api/xmatrix/relay-v2/projection/object-capability",
  relay_v2_private_r2: "/api/xmatrix/relay-v2/private-r2",
  spaces: "/api/xmatrix/spaces",
  space: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}`,
  space_restore: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/restore`,
  space_deletions: "/api/xmatrix/space-deletions",
  personal_space: "/api/xmatrix/personal-space",
  setup_intents: "/api/xmatrix/setup-intents",
  setup_intent: (intentId: string) => `/api/xmatrix/setup-intents/${encodeURIComponent(intentId)}`,
  setup_intent_approve: (intentId: string) => `/api/xmatrix/setup-intents/${encodeURIComponent(intentId)}/approve`,
  setup_intent_decline: (intentId: string) => `/api/xmatrix/setup-intents/${encodeURIComponent(intentId)}/decline`,
  space_billing: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/billing`,
  space_billing_checkout: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/billing/checkout`,
  space_billing_portal: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/billing/portal`,
  space_billing_reconcile: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/billing/reconcile`,
  space_billing_apple: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/billing/apple`,
  space_billing_apple_prepare: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/billing/apple/prepare`,
  space_billing_apple_reconcile: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/billing/apple/reconcile`,
  space_member_permissions: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/member-permissions`,
  space_channel_about: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/channel-about`,
  space_locale_preference: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/locale-preference`,
  space_channel_view_preference: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/channel-view-preference`,
  space_claims: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/claims`,
  space_claim: (spaceId: string, claimId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/claims/${encodeURIComponent(claimId)}`,
  space_members: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/members`,
  space_member: (spaceId: string, userId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`,
  space_invites: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/invites`,
  space_join: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/join`,
  space_join_requests: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/join-requests`,
  channel_transfer_proposals: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/transfer-proposals`,
  machine_name: (machineId: string) => `/api/xmatrix/machines/${encodeURIComponent(machineId)}/name`,
  machine_resource_history: (machineId: string) =>
    `/api/xmatrix/machines/${encodeURIComponent(machineId)}/resource-history`,
  machine_auto_assign: (machineId: string) => `/api/xmatrix/machines/${encodeURIComponent(machineId)}/auto-assign`,
  machine: (machineId: string) => `/api/xmatrix/machines/${encodeURIComponent(machineId)}`,
  space_channel_transfers: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/channel-transfers`,
  channel_transfer_ack: (spaceId: string, proposalId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/channel-transfers/${encodeURIComponent(proposalId)}/ack`,
  space_join_request_decide: (spaceId: string, requestId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/join-requests/${encodeURIComponent(requestId)}/decide`,
  space_invite_emails: (spaceId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/invite-emails`,
  space_app_connections: (spaceId: string, channelId?: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/app-connections${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ""}`,
  space_agent_registrations: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/agent-registrations`,
  space_agent_registration_command: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/agent-registrations/commands`,
  space_agent_registration_query: (spaceId: string) => `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/agent-registrations/query`,
  agent_environment_command: "/api/xmatrix/agent-environments/commands",
  agent_environment_query: "/api/xmatrix/agent-environments/query",
  ...appConnectionRoutes("/api/xmatrix"),
  space_invite: (token: string) => `/api/xmatrix/space-invites/${encodeURIComponent(token)}`,
  space_invite_accept: (token: string) =>
    `/api/xmatrix/space-invites/${encodeURIComponent(token)}/accept`,
  channels: "/api/xmatrix/channels",
  channel_catalog_page: "/api/xmatrix/channels/page",
  message_search: "/api/xmatrix/messages/search",
  channel_catalog_resolve: "/api/xmatrix/channels/resolve",
  channel: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}`,
  channel_history: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/history`,
  channel_read: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/read`,
  channel_join: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/join`,
  channel_leave: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/leave`,
  channel_messages: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/messages`,
  channel_message: (channelId: string, messageId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
  channel_message_reactions: (channelId: string, messageId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions`,
  channel_message_attachments: (channelId: string, messageId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/attachments`,
  channel_annotations: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/annotations`,
  migrations_slack: "/api/xmatrix/migrations/slack",
  slack_oauth_start: "/api/xmatrix/migrations/slack/oauth/start",
  slack_oauth_approve: "/api/xmatrix/migrations/slack/oauth/approve",
  slack_oauth_token: "/api/xmatrix/migrations/slack/oauth/token",
  observable_events: "/api/xmatrix/observable/events",
  trace_instance_events: (instanceId: string) =>
    `/api/xmatrix/trace/instances/${encodeURIComponent(instanceId)}/events`,
  channel_pending_cross_space_reads: (channelId: string) =>
    `/api/xmatrix/channels/${encodeURIComponent(channelId)}/cross-space-read-grants/pending`,
  cross_space_read_grant: (spaceId: string, grantId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/cross-space-read-grants/${encodeURIComponent(grantId)}`,
  cross_space_read_grant_decision: (spaceId: string, grantId: string) =>
    `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/cross-space-read-grants/${encodeURIComponent(grantId)}/decision`,
  context_feed: "/api/xmatrix/context/feed",
  assistant_memory: "/api/xmatrix/assistant-memory",
  shared_memory: "/api/xmatrix/shared-memory",
} as const;
export type AgentLifetime = "short" | "long";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

export type AuthProvider = "supabase" | "better-auth" | "mock";

export interface AuthResponse {
  token: string;
  refreshToken?: string;
  authProvider?: AuthProvider;
  user: AuthUser;
  hubUrl: string;
  relayUrl: string;
}

/**
 * The statuses an Agent Instance holds while its transport is live.
 *
 * `busy` and `idle` exist only in the Hub's live session — `data.instances.status`
 * is written as `online` or `offline` and never as either of them — so "is this
 * Instance live" is membership in this set, never `status === "online"`. The set
 * used to be respelled at every call site as an array, a `Set`, a union type and
 * a SQL `IN` list; the type, the predicates and the SQL below all read from here.
 */
export const LIVE_AGENT_STATUSES = ["online", "busy", "idle"] as const;
export type LiveAgentStatus = (typeof LIVE_AGENT_STATUSES)[number];

/** Every status an Instance can hold, live or not. */
export const AGENT_STATUSES = [...LIVE_AGENT_STATUSES, "offline"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export function isLiveAgentStatus(value: unknown): value is LiveAgentStatus {
  return typeof value === "string" &&
    (LIVE_AGENT_STATUSES as readonly string[]).includes(value);
}

export function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === "string" &&
    (AGENT_STATUSES as readonly string[]).includes(value);
}

/** `... AND i.status IN (${LIVE_AGENT_STATUS_SQL})` — the same set as the predicate. */
export const LIVE_AGENT_STATUS_SQL = LIVE_AGENT_STATUSES
  .map((status) => `'${status}'`)
  .join(",");

/**
 * Why an offline Instance still belongs to its Channel (docs/instance-sleep.md).
 * `sleeping` and `interrupted` Instances are woken by the next message in their
 * Channel; `waking` is either of them while its wake is in progress;
 * `wake_failed` is one whose wake failed (`restReason` says why), which only an
 * explicit `:reborn` resumes. A stopped Instance has no rest state here: it has
 * left the Channel.
 */
export const AGENT_INSTANCE_RESTS = ["sleeping", "interrupted", "waking", "wake_failed"] as const;
export type AgentInstanceRest = (typeof AGENT_INSTANCE_RESTS)[number];

export function isAgentInstanceRest(value: unknown): value is AgentInstanceRest {
  return typeof value === "string" &&
    (AGENT_INSTANCE_RESTS as readonly string[]).includes(value);
}

/**
 * Why a connected Instance is projected `offline`. `machine_offline`: the
 * Instance's own socket is open, but the Machine Daemon that hosts its Run is
 * not (disconnected or failed delivery), so
 * nothing it is sent is acted on until that machine returns. It is a presence
 * projection only: it changes no membership, access or Run state.
 */
export const AGENT_INSTANCE_OFFLINE_REASONS = ["machine_offline"] as const;
export type AgentInstanceOfflineReason = (typeof AGENT_INSTANCE_OFFLINE_REASONS)[number];

export function isAgentInstanceOfflineReason(value: unknown): value is AgentInstanceOfflineReason {
  return typeof value === "string" &&
    (AGENT_INSTANCE_OFFLINE_REASONS as readonly string[]).includes(value);
}

/**
 * An Instance the Channel still shows: live, offline and resting, or offline
 * because its machine is. Both offline cases keep `status: "offline"`, so
 * clients that predate `rest` or `offlineReason` treat them as gone, never as
 * idle.
 */
export function isChannelResidentInstance(
  instance: { status?: unknown; rest?: unknown; offlineReason?: unknown },
): boolean {
  return isLiveAgentStatus(instance.status) ||
    (instance.status === "offline" &&
      (isAgentInstanceRest(instance.rest) || isAgentInstanceOfflineReason(instance.offlineReason)));
}
export type AgentRuntimeWorkStatus = "idle" | "running";
/** Reported execution evidence; the receiving authority must validate each source. */
export interface AgentRuntimeMessageSource {
  channelId: string;
  messageId: string;
  sequence: number;
  entityVersion: number;
  bodyHash: string;
}
export interface AgentRuntimeExecutionEvidence {
  executionId: string;
  revision: number;
  sourceCount: number;
  sources: AgentRuntimeMessageSource[];
  state: "accepted" | "running" | "completed" | "failed" | "interrupted" | "unknown";
  inputDisposition?: "pending" | "submitted" | "resumed_existing";
  startedAtMillis: number;
  updatedAtMillis: number;
  finishedAtMillis?: number;
}
/**
 * What an Instance with work in hand is waiting on while its model produces
 * nothing (docs/design/agent-status.md). The runtime declares it; clients
 * present it and never derive it from traces.
 *
 * `tool`: a tool call (a command, a CI watch, a network request) has run past
 * the runtime's threshold without returning. `background`: the turn ended,
 * but background tasks it started are still running and will start the next
 * turn when they finish.
 */
export const AGENT_RUNTIME_WAITING_KINDS = ["tool", "background"] as const;
export type AgentRuntimeWaitingKind = (typeof AGENT_RUNTIME_WAITING_KINDS)[number];

export function isAgentRuntimeWaitingKind(value: unknown): value is AgentRuntimeWaitingKind {
  return typeof value === "string" &&
    (AGENT_RUNTIME_WAITING_KINDS as readonly string[]).includes(value);
}
export interface AgentRuntimeWaiting {
  kind: AgentRuntimeWaitingKind;
  /**
   * What it waits on, as the harness says it: a tool call's own description,
   * else its command, URL, query or tool name; for background tasks, their
   * count ("2 tasks").
   */
  label?: string;
  /**
   * The rest of what the harness says: the command under a described call,
   * or each background task's description.
   */
  details?: string[];
  /** When the wait began. */
  sinceMillis: number;
}
export interface AgentRuntimeState {
  status: AgentRuntimeWorkStatus;
  source?: string;
  activeChannelId?: string;
  activeMessageId?: string;
  activeThreadId?: string;
  activeTurnId?: string;
  startedAtMillis?: number;
  updatedAtMillis?: number;
  execution?: AgentRuntimeExecutionEvidence;
  recentExecutions?: AgentRuntimeExecutionEvidence[];
  waiting?: AgentRuntimeWaiting;
  /** Host-reported execution symptoms, shared by every harness. No raw diagnostics. */
  issue?: AgentRuntimeIssue;
  /** An advisory is separate from execution state, even at error severity. */
  notice?: AgentRuntimeNotice;
}

export const AGENT_RUNTIME_ISSUE_KINDS = ["retrying", "failed", "stalled"] as const;
export type AgentRuntimeIssueKind = (typeof AGENT_RUNTIME_ISSUE_KINDS)[number];
export function isAgentRuntimeIssueKind(value: unknown): value is AgentRuntimeIssueKind {
  return typeof value === "string" && (AGENT_RUNTIME_ISSUE_KINDS as readonly string[]).includes(value);
}
export interface AgentRuntimeIssue {
  kind: AgentRuntimeIssueKind;
  /** The first retry/failure, or the last progress for a stalled turn. */
  sinceMillis: number;
}

export const AGENT_RUNTIME_NOTICE_SEVERITIES = ["info", "warning", "error", "unknown"] as const;
export type AgentRuntimeNoticeSeverity = (typeof AGENT_RUNTIME_NOTICE_SEVERITIES)[number];
export function isAgentRuntimeNoticeSeverity(value: unknown): value is AgentRuntimeNoticeSeverity {
  return typeof value === "string" && (AGENT_RUNTIME_NOTICE_SEVERITIES as readonly string[]).includes(value);
}
/** Public presence carries a safe summary; the supplied text stays in the host trace. */
export interface AgentRuntimeNotice {
  severity: AgentRuntimeNoticeSeverity;
  sinceMillis: number;
}
export type AgentLifecycleLayer = "transport" | "application" | "process";
export type AgentLifecycleStatus =
  | "online"
  | "offline"
  | "reconnecting"
  | "reconnected"
  | "stale"
  | "failed"
  | "exited"
  | "blocked"
  | "stopped";
export type AgentLifecycleReason =
  | "heartbeat_timeout"
  | "reconnecting"
  | "reconnected"
  | "websocket_closed"
  | "websocket_send_failed"
  | "replaced_by_new_connection"
  | "replaced_by_reconnect"
  | "shutdown_requested"
  | "kill_blocked"
  | "token_refresh_failed"
  | "codex_timeout"
  | "app_server_exited"
  | "agent_exited"
  | "stopped"
  | "turn_failed"
  | "usage_limited"
  | "background_tasks_interrupted"
  | "unknown";

/** Canonical application-layer signal that a provider turn failed. Hub persists the channel notice. */
export const AGENT_TURN_FAILURE_LIFECYCLE_LAYER: AgentLifecycleLayer = "application";
export const AGENT_TURN_FAILURE_LIFECYCLE_STATUS: AgentLifecycleStatus = "failed";
export const AGENT_TURN_FAILURE_LIFECYCLE_REASON: AgentLifecycleReason = "turn_failed";
/** A turn failure because the provider account's usage limit is used up. */
export const AGENT_USAGE_LIMIT_LIFECYCLE_REASON: AgentLifecycleReason = "usage_limited";

const AGENT_TURN_FAILURE_DETAIL_MAX_CHARS = 600;

export function isAgentTurnFailureLifecycle(message: {
  layer?: string | null;
  status?: string | null;
  reason?: string | null;
}): boolean {
  return message.layer === AGENT_TURN_FAILURE_LIFECYCLE_LAYER
    && message.status === AGENT_TURN_FAILURE_LIFECYCLE_STATUS
    && (message.reason === AGENT_TURN_FAILURE_LIFECYCLE_REASON || message.reason === AGENT_USAGE_LIMIT_LIFECYCLE_REASON);
}

/** The turn failed because the provider account's usage limit is used up. */
export function isAgentUsageLimitLifecycle(message: {
  layer?: string | null;
  status?: string | null;
  reason?: string | null;
}): boolean {
  return isAgentTurnFailureLifecycle(message) && message.reason === AGENT_USAGE_LIMIT_LIFECYCLE_REASON;
}

export function boundAgentTurnFailureDetail(detail: string | undefined | null): string {
  const compact = (detail ?? "").replace(/\s+/gu, " ").trim();
  if (!compact) return "";
  return Array.from(compact).slice(0, AGENT_TURN_FAILURE_DETAIL_MAX_CHARS).join("");
}

export function agentTurnFailureNoticeBody(input: {
  agentName: string;
  detail?: string | null;
}): string {
  const name = input.agentName.trim() || "agent";
  const detail = boundAgentTurnFailureDetail(input.detail);
  if (!detail) {
    return `xMatrix could not complete this ${name} turn.`;
  }
  return `xMatrix could not complete this ${name} turn: ${detail}`;
}

export interface AgentLifecycleSnapshot {
  presence?: AgentLifecycleStatus;
  run?: AgentLifecycleStatus;
  process?: AgentLifecycleStatus;
}

export interface SerializedAgent {
  id: string;
  /** Retained compatibility address, independent of the display label. */
  addressName?: string;
  /**
   * Globally unique live instance id. Present only when serialization is scoped
   * to one concrete channel-active session.
   */
  instanceId?: string;
  /**
   * Per-channel ordinal used only for channel-visible addressing such as
   * `@agent:1`. It is not an instance identity and must not key traces,
   * controls, storage, or cross-channel relations.
   */
  channelInstanceId?: string;
  userId: string;
  name: string;
  type: string;
  lifetime: AgentLifetime;
  email: string;
  metadata: Record<string, unknown>;
  connectedAt: string;
  lastSeenAt: string;
  status: AgentStatus;
  /** Set only with `status: "offline"` on a live Instance whose machine is unreachable. */
  offlineReason?: AgentInstanceOfflineReason;
  avatarUrl?: string;
  activity?: string;
  files?: string[];
  intent?: string;
  runtimeState?: AgentRuntimeState;
  model?: string;
  usage?: LlmUsage;
  skills?: AgentSkill[];
  instances?: SerializedAgentInstance[];
}

export interface SerializedMachineDaemon {
  id: string;
  userId: string;
  name: string;
  email: string;
  metadata: Record<string, unknown>;
  connectedAt: string;
  lastSeenAt: string;
  status: AgentStatus;
  activity?: string;
  machineId?: string;
  /** The owner's name for this Machine; data, not identity. */
  machineName?: string;
  /** For a WSL distribution, the Machine id of its Windows host. */
  parentMachineId?: string;
  /** Its owner keeps it out of automatic assignment; absent, it takes part. */
  autoAssign?: false;
  /** Agent Runs starting or running on this Machine. */
  activeRuns?: number;
  /**
   * Set while this online daemon has left work unanswered: since when a command
   * sent to it has waited unclaimed, or a lease it held has lapsed, past a
   * minute. `status` and `lastSeenAt` follow connection events only, so this is
   * the evidence that an "online" route is not actually responding. Presence
   * only; absent from Hubs that predate it.
   */
  unansweredSince?: string;
  /** Latest operating-system computer name; an observation, never identity. */
  hostname?: string;
  hostId?: string;
  hostName?: string;
  daemonVersion?: string;
  cliVersion?: string;
  appVersion?: string;
}

export interface SerializedAutomation {
  id: string;
  /** CAS authority for every Automation mutation. */
  version: number;
  ownerUserId: string;
  authorityRootUserId: string;
  name: string;
  /** The conversation it runs in; for a page's Automation, a conversation of its own. */
  channelId: string;
  /** The page it belongs to (docs/design/pages-live-document.md §6); its section is where the page references it. */
  pageId?: string;
  /** The section of the page its reference is in, when read through its page ('' before the first heading). */
  blockId?: string;
  /** The page's Space, with pageId. */
  spaceId?: string;
  /** When its reference left the page; it stays paused until the reference is back. */
  detachedAt?: string;
  /** What else makes it run now, besides its cadence (a page's Automation only). */
  triggers?: AutomationTrigger[];
  /** Events that made it due and that its next occurrence will name. */
  triggerEvents?: AutomationTriggerEvent[];
  payloadVersion?: 2 | 3;
  /** Principal-specific capability; readable Automations may still be immutable to this Human. */
  canManage: boolean;
  /** Principal-specific action capabilities computed by Relay authority. */
  capabilities: AutomationCapabilities;
  /** Expression repeatedly evaluated by the Channel evaluator. */
  expression: AutomationExpression;
  /** Canonical v3 input; absent when a payload has no evaluator binding (legacy v2). */
  input?: PersistedEvalInput;
  /** @deprecated Compatibility projection for payloadVersion 2 clients. */
  message: AutomationMessage;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastRunId?: string;
  /** Authoritative status of lastRunId from the durable Run record. */
  lastRunStatus?: string;
  /** Terminal timestamp of lastRunId, absent while the Run is active. */
  lastRunFinishedAt?: string;
  lastError?: string;
  /** Latest durable dispatch attempt, including a retryable failure that has not produced a Run. */
  latestExecution?: AutomationExecutionStatus;
  /** Successful scheduled deliveries; migrated legacy Agent runs remain counted. */
  deliveryCount: number;
  lastDeliveryAt?: string;
  lastMessageId?: string;
  /** Legacy Agent-bound fields remain readable only until migration completes. */
  workspace?: WorkspaceRef;
  agentId?: string;
  agentName?: string;
  prompt?: string;
  executionTimeoutMinutes?: number;
  runCount: number;
}

/**
 * What makes a page's Automation run now, besides its cadence
 * (docs/design/pages-live-document.md §6.2). A trigger never queues work: it
 * makes the next occurrence due, and events coalesce.
 */
export type AutomationTrigger =
  | { kind: "merged"; repository: string; branch?: string; paths?: string[]; installationId?: string }
  | { kind: "ci-failed"; repository: string; branch?: string; workflow?: string; installationId?: string }
  | { kind: "owed" }
  /** A connector event (docs/design/connector-platform.md §3.4): a provider's source, `*` for any, and feature. */
  | { kind: "event"; provider: string; source: string; feature?: string };

/** An event that fired an Automation, named in the occurrence it made due. */
export interface AutomationTriggerEvent {
  kind: AutomationTrigger["kind"];
  at: string;
  summary: string;
  url?: string;
}

const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const TRIGGER_TEXT = /^[^\s][^\n]{0,199}$/u;

/* A connector event trigger names a provider that delivers events, one of its
   sources (or `*`) and optionally one of its features. */
function connectorEventTrigger(trigger: Record<string, unknown>): AutomationTrigger {
  const providerId = typeof trigger.provider === "string" ? trigger.provider.trim().toLowerCase() : "";
  const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find((candidate) => candidate.id === providerId);
  if (!manifest?.events) throw new Error("an event trigger names a connector that delivers events");
  const source = typeof trigger.source === "string" && trigger.source.trim() ? trigger.source.trim().toLowerCase() : "*";
  if (source !== "*" && !new RegExp(manifest.events.source.pattern, "u").test(source)) {
    throw new Error(`an event trigger's source is a ${manifest.name} ${manifest.events.source.label.toLowerCase()} or *`);
  }
  const feature = typeof trigger.feature === "string" && trigger.feature.trim() && trigger.feature.trim() !== "*"
    ? trigger.feature.trim().toLowerCase() : undefined;
  if (feature && !manifest.events.features.some((candidate) => candidate.id === feature)) {
    throw new Error(`${manifest.name} events are ${manifest.events.features.map((candidate) => candidate.id).join(", ")}`);
  }
  return { kind: "event", provider: manifest.id, source, ...(feature ? { feature } : {}) };
}

/**
 * An Automation's triggers as a writer gave them, validated and bounded; the
 * Hub sets each GitHub trigger's installationId from the Space's connection.
 * Throws on anything else.
 */
export function automationTriggersFrom(value: unknown): AutomationTrigger[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("triggers is a list of at most 8 triggers");
  const text = (field: unknown, name: string): string | undefined => {
    if (field === undefined || field === null || field === "") return undefined;
    if (typeof field !== "string" || !TRIGGER_TEXT.test(field.trim())) throw new Error(`${name} is invalid`);
    return field.trim();
  };
  const seen = new Set<string>();
  return value.map((entry) => {
    const trigger = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    let result: AutomationTrigger;
    if (trigger.kind === "owed") result = { kind: "owed" };
    else if (trigger.kind === "merged" || trigger.kind === "ci-failed") {
      const repository = typeof trigger.repository === "string" ? trigger.repository.trim() : "";
      if (!REPOSITORY_NAME.test(repository)) throw new Error("a GitHub trigger names its repository as owner/repo");
      const branch = text(trigger.branch, "branch");
      if (trigger.kind === "merged") {
        const paths = trigger.paths === undefined ? [] : Array.isArray(trigger.paths) && trigger.paths.length <= 20
          ? trigger.paths.map((path) => text(path, "path")).filter((path): path is string => Boolean(path))
          : (() => { throw new Error("paths is a list of at most 20 path prefixes"); })();
        result = { kind: "merged", repository, ...(branch ? { branch } : {}), ...(paths.length ? { paths } : {}) };
      } else {
        const workflow = text(trigger.workflow, "workflow");
        result = { kind: "ci-failed", repository, ...(branch ? { branch } : {}), ...(workflow ? { workflow } : {}) };
      }
    } else if (trigger.kind === "event") {
      result = connectorEventTrigger(trigger);
    } else throw new Error("a trigger is merged, ci-failed, owed or a connector event");
    const key = JSON.stringify(result);
    if (seen.has(key)) throw new Error("a trigger is listed twice");
    seen.add(key);
    return result;
  });
}

export interface AutomationExecutionStatus {
  status: "pending" | "leased" | "prepared" | "dispatched" | "failed" | "cancelled";
  attempts: number;
  scheduledFor: string;
  nextAttemptAt: string;
  updatedAt: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface AutomationCapabilities {
  update: boolean;
  pause: boolean;
  /** Always false; pause-request approval is retired. Sent for CLIs that still require it. */
  requestPause: false;
  resume: boolean;
  delete: boolean;
  reasonRequired: boolean;
}

export interface AutomationMessage {
  body: string;
  appMentions?: ChannelAppMention[];
}

export interface AutomationExpression extends EvalExpression {
  kind: "text";
  language: "natural-language";
  text: string;
  appMentions?: ChannelAppMention[];
}

/** Authoring shape; Hub assigns a stable evaluator ref when a writer omits it. */
export type AutomationExpressionInput = Omit<AutomationExpression, "ref"> & {
  ref?: string;
};

export interface PersistedEvalEnvironmentRef {
  /** Outermost REPL/environment to which this closure is bound. */
  root: { kind: "channel"; id: string };
  actor: { kind: "user" | "agent"; id: string };
  /** Human authority root used for revocation and resource accounting. */
  authorityRootUserId: string;
}

export type EvalResumeCondition = {
  kind: "interval";
  intervalMinutes: number;
};

/** Durable evaluator input. Automation is a projection of this value. */
export interface PersistedEvalInput {
  datum: AutomationExpression;
  envRef: PersistedEvalEnvironmentRef;
  resume: EvalResumeCondition;
  lineage: {
    rootMessageId: string;
    parentInputId?: string;
    depth: number;
    budget: number;
  };
}

export interface SerializedAutomationCatalog {
  automations: SerializedAutomation[];
  /** Exact Hub rollout capability; false means saved schedules cannot execute. */
  executionEnabled: boolean;
  /** Exact Hub rollout capability; absent/false makes Agent management fail closed. */
  agentManagementEnabled: boolean;
}

export interface AutomationUpdateRequest {
  expectedVersion: number;
  name?: string;
  expression?: AutomationExpressionInput;
  /** @deprecated Accepted only as a migration input. */
  message?: AutomationMessage;
  intervalMinutes?: number;
}

/**
 * Provider-neutral live presentation produced by an Agent runtime adapter.
 *
 * Every runtime family maps its native events into this contract before the
 * snapshot reaches Hub/Web. Omitted fields mean "not authoritatively
 * reported"; consumers and adapters must not invent vendor defaults. Dynamic
 * vendor labels belong in `statusChips` instead of new fixed fields.
 */
export interface AgentPresentationSnapshot {
  /** Choices observed by the exact runtime; [] clears a removed catalog. */
  parameters?: import("./harness-parameters.js").HarnessParameter[];
  model?: string;
  models?: AgentModelInfo[];
  /** Currently selected reasoning effort, when reported by the runtime. */
  effort?: string;
  /** Commands advertised by the exact live runtime plus its reviewed catalog. */
  commands?: AgentInstanceCommand[];
  /** Extensible runtime labels captured into immutable message headers. */
  statusChips?: AgentStatusChip[];
  /** Token, context, cost, and quota facts reported by the runtime/provider. */
  usage?: LlmUsage;
}

export interface SerializedAgentInstance extends AgentPresentationSnapshot {
  /**
   * Globally unique live instance id. Use this for traces, controls, storage,
   * and any non-mention identity comparison.
   */
  id: string;
  /**
   * Per-channel ordinal used only for channel-visible addressing such as
   * `@agent:1`.
   */
  channelInstanceId?: string;
  /**
   * Channel this live instance is registered in. `channelInstanceId` ordinals
   * are only meaningful inside this channel; consumers must not match slots
   * across channels without comparing this scope first.
   */
  channelId?: string;
  label: string;
  /**
   * Version of the xMatrix client that registered this live instance.
   */
  clientVersion?: string;
  connectedAt: string;
  lastSeenAt: string;
  status: AgentStatus;
  /**
   * Set only with `status: "offline"`: this Instance is resting, not gone, and
   * the next message in its Channel wakes it (docs/instance-sleep.md).
   */
  rest?: AgentInstanceRest;
  /** Set only with `rest: "wake_failed"`: the failure code, then what the failing step said. */
  restReason?: string;
  /** Set only with `status: "offline"` on a live Instance whose machine is unreachable. */
  offlineReason?: AgentInstanceOfflineReason;
  machineId?: string;
  /** Mutable OS observation; never selects or authorizes a Machine. */
  hostname?: string;
  hostId?: string;
  hostName?: string;
  cwd?: string;
  workspace?: WorkspaceRef;
  workspaceName?: string;
  /**
   * Current git branch reported by the live instance, when its cwd is inside a
   * repository. Detached heads and non-git directories leave this unset.
   */
  gitBranch?: string;
  /**
   * Ref the instance's managed run worktree was cut from, when the daemon
   * materialized one for this run (execution-context display).
   */
  runWorktreeBaseRef?: string;
  activity?: string;
  files?: string[];
  intent?: string;
  runtimeState?: AgentRuntimeState;
  /** Provider-backed operations advertised by this exact live runtime. */
  capabilities?: string[];
  goal?: AgentGoalStatus;
  skills?: AgentSkill[];
}

/**
 * How a runtime-advertised slash command should be handled by Hub.
 * - `passthrough` (default): deliver `@agent:n /cmd ...` as the leading slash
 *   command to the underlying agent (no Hub interception).
 * - `typed`: Hub intercepts into a known control path (`/model`, `/effort`,
 *   `/goal`, …) instead of forwarding as an LLM prompt.
 */
export type AgentInstanceCommandMode = "passthrough" | "typed";

/**
 * Runtime-advertised instance slash command for Composer completion and
 * optional typed control routing.
 */
export interface AgentInstanceCommand {
  /** Command token including leading slash, e.g. `/effort`. */
  token: string;
  label: string;
  description?: string;
  mode?: AgentInstanceCommandMode;
  /**
   * Named dynamic argument source for the next segment after the command.
   * When omitted and freeform is not set, the command has no completable args.
   */
  argumentSource?: "agent-models" | "agent-efforts";
  /** When true, remaining text after the command is free-form. */
  freeform?: boolean;
}

/**
 * One status chip rendered in live instance UI and agent message headers.
 * Values are snapshots; historical messages keep the chips captured at send.
 */
export interface AgentGoalStatus {
  active?: boolean;
  objective?: string;
  status?: string;
  updatedAt?: string;
  reason?: string;
  nextAction?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  iterationCount?: number;
  contextUsed?: number;
  toolCallCount?: number;
}

export interface AgentModelReasoningEffort {
  reasoningEffort: string;
  description?: string;
}

export interface AgentModelInfo {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: AgentModelReasoningEffort[];
  inputModalities?: string[];
  supportsPersonality?: boolean;
  upgrade?: string;
}

export type WorkspaceVisibility = "private" | "channel" | "space";

export interface WorkspaceRef {
  machineId: string;
  canonicalCwd: string;
}

export interface SerializedWorkspace extends WorkspaceRef {
  ownerUserId: string;
  hostId: string;
  hostName?: string;
  hostname?: string;
  canonicalCwd: string;
  displayName: string;
  repoRoot?: string;
  gitRemote?: string;
  gitBranch?: string;
  runtimesSeen: string[];
  boundChannelIds: string[];
  visibility: WorkspaceVisibility;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * The statuses a Run holds until it has exited: it still owns its Instance and
 * workspace, so "is this Run active" is membership in this set. Like
 * {@link LIVE_AGENT_STATUSES}, the type, the predicate and the SQL read from here.
 */
export const ACTIVE_RUN_STATUSES = ["starting", "running", "stopping"] as const;
export type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];

/**
 * The statuses a Run holds once it has exited. Like {@link ACTIVE_RUN_STATUSES},
 * the type, the predicate and the SQL read from here, so callers never respell it.
 */
export const TERMINAL_RUN_STATUSES = ["stopped", "failed", "exited", "completed"] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

/** Every status a Run can hold, active or not. */
export const RUN_STATUSES = [...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export function isActiveRunStatus(value: unknown): value is ActiveRunStatus {
  return typeof value === "string" &&
    (ACTIVE_RUN_STATUSES as readonly string[]).includes(value);
}

export function isTerminalRunStatus(value: unknown): value is TerminalRunStatus {
  return typeof value === "string" &&
    (TERMINAL_RUN_STATUSES as readonly string[]).includes(value);
}

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" &&
    (RUN_STATUSES as readonly string[]).includes(value);
}

/** `... AND r.status IN (${ACTIVE_RUN_STATUS_SQL})` — the same set as the predicate. */
export const ACTIVE_RUN_STATUS_SQL = ACTIVE_RUN_STATUSES
  .map((status) => `'${status}'`)
  .join(",");

/** `... AND r.status IN (${TERMINAL_RUN_STATUS_SQL})` — the same set as the predicate. */
export const TERMINAL_RUN_STATUS_SQL = TERMINAL_RUN_STATUSES
  .map((status) => `'${status}'`)
  .join(",");

/** Kept only for the spawn field older daemons read; Agents no longer run in a local sandbox. */
export type AgentSandboxMode = "off";

export type MachineRequestRememberPolicy = "once" | "instance" | "exact" | { prefixLen: number };

/** An environment variable name a secret can be injected as. */
export const SECRET_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,119}$/u;

/** How a Space secret reaches an Agent Run: `auto` to any live Run in the
 * Space whenever it asks; `ask` only after a Space admin approves that Run on
 * a card in its Channel. Nothing is injected when a Run starts. */
export const SPACE_SECRET_ACCESS = ["auto", "ask"] as const;
export type SpaceSecretAccess = (typeof SPACE_SECRET_ACCESS)[number];

export function isSpaceSecretAccess(value: unknown): value is SpaceSecretAccess {
  return value === "auto" || value === "ask";
}

/** A secret of a Space, as its members see it; the value is never included. */
export interface SpaceSecretEntry {
  secretRef: string;
  envName: string;
  description?: string;
  access: SpaceSecretAccess;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** A card an Agent posts in its Channel for a Space secret it may not read yet. */
export const SECRET_REQUEST_MESSAGE_KIND = "xmatrix.system.secret-request";

/** What a secret request card asks for; the value is typed on the card and
 * never carried here. `envName` is the Agent's suggestion for a secret the
 * Space does not hold yet; a saved secret keeps its own. */
export interface SecretRequestCard {
  secretRef: string;
  envName?: string;
  description?: string;
  reason?: string;
  agentName?: string;
  runId: string;
  channelId: string;
}

/** The trusted `secretRequest` metadata of a card, or null. */
export function parseSecretRequestCard(value: unknown): SecretRequestCard | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = (field: string, max: number) => typeof row[field] === "string" && (row[field] as string).trim() &&
    (row[field] as string).length <= max ? (row[field] as string).trim() : undefined;
  const secretRef = text("secretRef", 160), envName = text("envName", 120);
  const runId = text("runId", 300), channelId = text("channelId", 200);
  if (!secretRef || (envName && !SECRET_ENV_NAME_PATTERN.test(envName)) || !runId || !channelId) return null;
  const optional = (field: string, max: number) => { const item = text(field, max); return item ? { [field]: item } : {}; };
  return { secretRef, ...(envName ? { envName } : {}), ...optional("description", 600), ...optional("reason", 600),
    ...optional("agentName", 120), runId, channelId };
}

/** One repo the Channel's Space is authorized to launch an Agent into. */
export interface LaunchTargetRepo {
  /** The reference a mention carries, e.g. `owner/repo`. */
  value: string;
  private: boolean;
}

/**
 * Why a Space has no repo targets. Selection asks exactly what the machine's
 * credential mint asks — a configured connector for this Channel's Space — so a
 * repo offered here is a repo the run can actually be given a token for.
 */
export type LaunchTargetRepoStatus = "authorized" | "not-connected" | "unavailable";

/**
 * The launch targets of one Space, already authorized.
 *
 * Repos come from the Space; registered directories are local paths and are
 * returned only for the caller. The two lists are disjoint by
 * construction, so no client re-derives a repo from a directory.
 */
export interface SpaceLaunchTargetsResponse {
  spaceId: string;
  repos: LaunchTargetRepo[];
  repoStatus: LaunchTargetRepoStatus;
  /** Present when `repoStatus` is not `authorized`. */
  repoStatusDetail?: string;
  workspaces: SerializedWorkspace[];
}
