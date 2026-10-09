export { createAuthorityDatabase, type AuthorityDatabaseOptions } from "./client.js";
export {
  legacyChannelRouteUuidRanges,
  PostgresChannelCatalogRepository,
  type ChannelCatalogPageCursor,
  type ChannelCatalogPageFilter,
  type ChannelCatalogPageInput,
  type ChannelCatalogPageView,
  type ChannelCatalogResolveInput,
  type ChannelHeadMessage,
} from "./channel-catalog.js";
export {
  createAuthorityDatabaseRouter,
  type AuthorityDatabaseRouterOptions,
} from "./router.js";
export {
  BillingControlError,
  PostgresBillingRepository,
  type StripeSubscriptionFact,
  type BillingSubscriptionFact,
} from "./billing-control.js";
export {
  ContentControlError,
  PostgresContentRepository,
  type ContentPrincipal,
} from "./content-control.js";
export type {
  AuthorityDatabase,
  AuthorityDatabaseSession,
  DatabaseHealth,
  DatabaseObservation,
  DatabaseObserver,
  DatabaseQuery,
  DatabaseSessionObservation,
  DatabaseSessionObserver,
  DatabaseTransaction,
} from "./contracts.js";
export {
  databaseRequestContext,
  InvalidDatabaseContextError,
  type DatabasePlacementContext,
  type DatabaseRequestContext,
} from "./context.js";
export type { MessagePreview } from "./message-preview.js";
export {
  DatabaseCommitUnknownError,
  DatabaseContractError,
  DatabasePlacementStaleError,
  DatabaseRowLimitError,
} from "./errors.js";
export {
  ConnectivityBreaker,
  connectivityFailureCode,
  DatabaseCircuitOpenError,
} from "./connectivity-breaker.js";
export {
  PostgresEntitySpaceDirectory,
  type EntitySpaceRoute,
  type EntitySpaceRouteKind,
  type EntitySpaceRouteMutation,
} from "./entity-directory.js";
export {
  PostgresUserSpaceMembershipDirectory,
  type UserSpaceMembershipRoute,
  type UserSpaceMembershipRouteMutation,
} from "./membership-directory.js";
export {
  MessageAuthorityError,
  PostgresMessageRepository,
  type AppendPostgresMessage,
  type MessagePrincipal,
  type MessageSearchCandidate,
  type PostgresMessagePlacement,
  type PostgresMessageAgentRunIdentity,
  type PostgresMessageCollectionMutation,
  type PreparedPostgresMessageAppend,
  type PostgresMessageMutationBase,
  type PostgresMessageSenderIdentity,
  type PostgresSenderSnapshotRepair,
  type PreparedPostgresMessageRecord,
} from "./message-control.js";
export {
  PostgresChannelSpaceDirectory,
  PostgresSpacePlacementDirectory,
  SpacePlacementHints,
  type ChannelSpaceDirectoryMutation,
  type ChannelSpaceRoute,
  type SpacePlacement,
} from "./placement.js";
export {
  PostgresSpaceControlRepository,
  SpaceControlError,
  type ChannelCatalogChangeAudience,
  type CreatePostgresChannel,
  type CreatePostgresSpace,
  type CreatePostgresSpaceInvite,
  type PostgresChannelMutation,
  type PostgresMembershipMutation,
  type PostgresSpaceMutation,
  type SpaceControlPrincipal,
  type UpdatePostgresSpaceMemberCreationPolicy,
} from "./space-control.js";
export {
  SPACE_DELETION_RESTORE_WINDOW_MS,
  SPACE_PURGE_EXCLUDED_TABLES,
  SPACE_PURGE_STEPS,
  type SpacePurgeStep,
} from "./space-deletion.js";
export {
  PostgresUserPreferenceRepository,
  UserPreferenceAuthorizationError,
  UserPreferenceConflictError,
  type UpdateUserSpaceChannelViewPreference,
  type UpdateUserSpaceLocalePreference,
  type UserPreferenceWriteResult,
  type UserSpaceChannelViewPreference,
  type UserSpaceLocalePreference,
} from "./user-preferences.js";
export { ControlError, DetailedControlError } from "./control-error.js";
export { PostgresWorkspaceRepository, WorkspaceControlError } from "./workspace-control.js";
export {
  PostgresSharedMemoryRepository,
  SharedMemoryControlError,
} from "./shared-memory-control.js";
export {
  AssistantMemoryControlError,
  PostgresAssistantMemoryRepository,
} from "./assistant-memory-control.js";
export {
  AppControlError,
  appendMetadataLists,
  appExecutionView,
  appPrincipal,
  appRequestFields,
  PostgresAppRepository,
  type AppProviderPolicy,
  type PostgresGitHubSubscriptionRoute,
} from "./app-control.js";
export {
  PostgresAppActionPolicyRepository,
  type AppActionPolicyMode,
} from "./app-action-policy-control.js";
export {
  PostgresAppCredentialRepository,
  type ResolvedAppCredentials,
  type AppOAuthInstallation,
} from "./app-credential-control.js";
export {
  HumanProfileControlError,
  PostgresHumanProfileRepository,
  type PostgresHumanProfile,
} from "./human-profile-control.js";
export { SecretValueControlError } from "./secret-value-control.js";
export {
  PostgresSpaceSecretRepository,
  SpaceSecretError,
  type RunSecretCaller,
  type RunSecretView,
} from "./space-secret-control.js";
export {
  PostgresRuntimeRepository,
  RuntimeControlError,
} from "./runtime-control.js";
export {
  allocateInstanceOrdinals, instanceOrdinalFor, naturalInstanceOrdinal, NaturalKeyError, reserveNaturalKey,
  type NaturalKeyReservation, type NaturalKeyScope,
} from "./natural-keys.js";
export {
  PostgresMachineLifecycleRepository,
  type MachineLifecycleInput,
} from "./runtime-lifecycle-control.js";
export {
  MachineControlError,
  PostgresMachineControlRepository,
} from "./machine-control.js";
export {
  PostgresMachineRunTerminalReportRepository,
  type MachineRunTerminalReport,
} from "./machine-run-terminal-reports.js";
export { MachineNameError, renameMachine, nameMachine, getMachineName, setMachineAutoAssign } from "./machine-names.js";
export { rejoinMachine, retireMachine } from "./machine-retirement.js";
export {
  MachineResourceHistoryError, maintainMachineResourceHistory, parseMachineResourceHistoryRange,
  readMachineResourceHistory,
} from "./machine-resource-history.js";
export { MachineIdentityAdoptionError, adoptLegacyMachineIds } from "./machine-identity-adoption.js";
export {
  PostgresAutomationRepository,
  AutomationControlError,
  CHANNEL_AUTOMATION_WAKE_SQL,
} from "./automation-control.js";
export {
  PostgresSchedulerControlRepository,
  SchedulerControlError,
} from "./scheduler-control.js";
export {
  PostgresTraceAccessRepository,
  TraceAccessControlError,
  type TraceAccessAuthorityResult,
  type TraceAccessNotification,
} from "./trace-access-control.js";
export {
  CrossSpaceReadError,
  PostgresCrossSpaceReadRepository,
  type CrossSpaceReadAction,
  type CrossSpaceReadAuthorization,
  type CrossSpaceReadGrant,
  type CrossSpaceReadScope,
  type CrossSpaceRunProof,
} from "./cross-space-read-control.js";
export {
  PostgresSlackOAuthRepository,
  SlackOAuthControlError,
} from "./slack-oauth-control.js";


export { withInitialMessageSource } from "./runtime-initial-input.js";
export { PostgresRegistrationAccessRepository, RegistrationAccessError, changeSpaceState,
  requireRegistrationAdmission } from "./agent-registration-access.js";
export { PostgresAgentRegistrationRepository } from "./agent-registration-control.js";
export { PostgresAgentEnvironmentRepository } from "./agent-registration-environment.js";
export { PostgresRegistrationExecutionRepository } from "./agent-registration-execution.js";
export { firstMessageSummonId, readMessageInvocationSelections, XMATRIX_SYSTEM_AUTHOR_ID } from "./message-invocation-selections.js";
export { PostgresRegistrationRevocationRepository, type RegistrationStopIntent } from "./agent-registration-revocation.js";

export type { RegistrationLaunchCandidate, RegistrationLaunchChooser, RegistrationAboutSession, ChannelAboutSessionStopTarget } from "./agent-registration-launch.js";
export { PostgresRegistrationLaunchRepository, reconcileRegistrationPreparationCancellations } from "./agent-registration-launch.js";
export { PostgresFirstMessageLaunchChoiceRepository, readFirstMessageLaunchChoices, type FirstMessageLaunchChooser } from "./first-message-launch-choice.js";
export { readRegistrationQuotaProbeTargets, REGISTRATION_QUOTA_PROBE_TARGET_PREFIX,
  type RegistrationQuotaProbeTarget } from "./agent-registration-quota-probe.js";

export {
  AgentChannelAccessError, PostgresAgentChannelAccessRepository, requireAgentChannelAccess,
} from "./agent-channel-access.js";
export type {
  AgentChannelRunProof,
} from "./agent-channel-access.js";

export { PostgresRegistrationRebornRepository, WAKE_FAILED_SQL } from "./registration-reborn.js";

export type { RegistrationRepositoryCatalog, RegistrationRepositoryReader } from "./registration-repository-authority.js";
export {
  inActiveSpace, pageAccess, pageAccessMap, pageActor, pageBody, PageControlError,
  pagePositionBetween, pageTitle, PostgresPageRepository,
} from "./page-control.js";
export type {
  PageActor, PageAuthor, PageClaim, PageCommit, PageDocument, PageLink, PagePrincipal, PageRevision,
  PageSummary, PublicPage,
} from "./page-control.js";
export {
  MAX_PAGE_CONVERSATIONS, readPageConversations,
} from "./page-conversations.js";
export type {
  PageConversationRecord,
} from "./page-conversations.js";
export {
  migratedPageId, PageMigrationError, PostgresPageMigrationRepository, revisedDraft, validDraft,
} from "./page-migration.js";
export type {
  PageMigration, PageMigrationDraft, PageMigrationDraftPage, PageMigrationReport,
  PageMigrationSource,
} from "./page-migration.js";
export {
  readsOnly,
} from "./space-roles.js";
export { readHarnessActionStatus, readHarnessReleaseTargets, readRecentHarnessActions, type HarnessReleaseTarget } from "./machine-harness-actions.js";
export { readLatestWorktreeListing, readWorktreeActionStatus } from "./machine-worktree-actions.js";
export { GovernanceError, PostgresGovernanceRepository, type SpaceGovernance } from "./governance.js";

export { observeRegistrationQuota, readOwnerRegistrationQuotaState, readRegistrationQuotaState, registrationQuotaKey,
  type RegistrationQuotaKey, type RegistrationQuotaReading } from "./registration-quota-state.js";

export { PostgresDiscordLifecycleRepository } from "./discord-installation-lifecycle.js";
export { PostgresSentryEventRepository, validateSentryEventIdentity, type SentryEventIdentity, type SentryEventKey, type SentryEventJob } from "./sentry-event-control.js";
export { PostgresGoogleChatRoomRepository, googleChatAppIdentity, type GoogleChatAppIdentity,
  type GoogleChatRoomBinding } from "./googlechat-room-control.js";

export { PostgresFeishuAppRepository } from "./feishu-app-control.js";
export { PostgresFeishuRoomRepository, feishuAppIdentity, type FeishuAppIdentity, type BotRoomBinding } from "./googlechat-room-control.js";

export { PostgresTelegramRoomRepository, telegramAppIdentity, telegramChatId, type TelegramAppIdentity } from "./googlechat-room-control.js";

export { PostgresWeComSuiteRepository, wecomAppIdentity, type WeComAppIdentity } from "./wecom-suite-control.js";
export { PostgresWeComInstallRepository } from "./wecom-install-control.js";
export { PostgresDingTalkInstallRepository } from "./dingtalk-install-control.js";
export { PostgresDingTalkCompanyRepository } from "./dingtalk-company-control.js";
export { PostgresDingTalkInboundConsentRepository, type DingTalkConversationVerifier } from "./dingtalk-inbound-consent.js";
export { PostgresDingTalkInboundInboxRepository } from "./dingtalk-inbound-inbox.js";
export { drainDingTalkInbound, type DingTalkInboundEffects, type DingTalkInboundEffectFence,
  type DingTalkInboundEvent } from "./dingtalk-inbound-drain.js";
export { dingtalkInboundCandidate, type DingTalkInboundCandidate, type DingTalkInboundScope,
  type DingTalkInboundSelection, type DingTalkInboundJob } from "./dingtalk-inbound-values.js";
export { PostgresDingTalkTokenRepository, type DingTalkTokenLease } from "./dingtalk-token-control.js";
export { PostgresDingTalkVisibilityRepository, type DingTalkVisibleScope } from "./dingtalk-visibility-control.js";
export { dingtalkRecipientRef, DINGTALK_CORP, DINGTALK_MEMBER, type DingTalkCompanySelection,
  type DingTalkCompanyGrant, type DingTalkInstallation } from "./dingtalk-company-values.js";
export { PostgresWeComCompanyRepository } from "./wecom-company-control.js";
export { wecomRecipientRef, type WeComCompanyGrant, type WeComInstallation } from "./wecom-company-values.js";

export { PostgresDingTalkSuiteRepository, dingtalkAppIdentity, type DingTalkAppIdentity } from "./dingtalk-suite-control.js";

export { PostgresTeamsRoomRepository } from "./googlechat-room-control.js";
export { teamsAppIdentity, teamsServiceUrl, teamsReference, teamsRoomId, MICROSOFT_GUID, type TeamsAppIdentity, type TeamsConversationReference } from "./teams-reference.js";

export type { DingTalkEffectAuthority, DingTalkEffectDestination } from "./dingtalk-effect-authority.js";

// No production prepared-path/native-proof issuer is exported or registered.
export { DingTalkEffectCoordinator,type DingTalkCoordinationNativeProof } from "./dingtalk-effect-coordinator.js";
export type { DingTalkPreparedPathCapability } from "./dingtalk-prepared-port.js";

export { PostgresAppleBillingRepository, type AppleAccountBinding } from "./apple-billing-control.js";

export { PostgresAccountDeletionRepository, AccountDeletionError } from "./account-deletion.js";
export type { AccountDeletionBlocker, AccountDeletionState } from "./account-deletion.js";
