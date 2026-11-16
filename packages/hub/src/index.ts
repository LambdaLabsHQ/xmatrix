// First, so that error reporting is open before anything else loads.
import "./error-reporting";
import { drainAppleCommerce } from "./connectors/app-store-connect-commerce";
import { registerAccountDeletionRoutes } from "./index-routes-account-deletion";
import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { ackRetiredExportQueue } from "./retired-export-queue";
import { registerMachineNameRoutes } from "./index-routes-machine-name";
import { registerMachineRetirementRoutes } from "./index-routes-machine-retirement";
import { registerHarnessActionRoutes } from "./index-routes-harness-actions";
import { registerHarnessSignInRequestRoutes } from "./index-routes-harness-sign-in-requests";
import { registerSettingsRequestRoutes } from "./index-routes-settings-requests";
import { registerWorktreeActionRoutes } from "./index-routes-worktree-actions";
import { registerCliUpdateCheckRoutes } from "./index-routes-cli-update-check";
import { registerMachineResourceRoutes } from "./index-routes-machine-resources";
import { registerSetupIntentRoutes } from "./index-routes-setup-intents";
import { registerWelcomeRoutes } from "./index-routes-welcome";
import { registerOnboardingFunnelRoutes } from "./index-routes-onboarding-funnel";
import { registerChannelTransferRoutes } from "./index-routes-channel-transfer";
import { registerPageRoutes } from "./index-routes-pages";
import { registerPageProgramRoutes } from "./index-routes-page-programs";
import { registerPageMigrationRoutes } from "./index-routes-page-migration";
import { registerGovernanceRoutes } from "./index-routes-governance";
import { registerPageGitRoutes } from "./index-routes-page-git";
import { registerMcpRoutes } from "./index-routes-mcp";
import { registerCrossSpaceReadRoutes } from "./cross-space-read";
import { registerSecretRoutes } from "./index-routes-secrets";
import { registerConnectorRoutes } from "./index-routes-connectors";
import { registerConnectorOAuthRoutes } from "./index-routes-connector-oauth";
import { registerMailSnapshotRoutes } from "./index-routes-mail-snapshot";
import { registerSentryInstallationRoutes } from "./index-routes-sentry-installation";
import { registerGooglePickerRoutes } from "./index-routes-google-picker";
import { registerGmailMailboxRoutes } from "./index-routes-gmail-mailboxes";
import { registerStripeAccountRoutes } from "./index-routes-stripe-accounts";
import { registerCloudflareLoginRoutes } from "./index-routes-cloudflare-logins";
import { redirectInsecureRequest } from "./https-redirect";
import { scheduledTaskFailed } from "./scheduled-task-failure";
import { runMinutePassesBesidePostgres } from "./scheduled-minute";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestErrorResponse } from "./index-shared";
import type { Env } from "./types";
export { RelaySummonDecisionClock } from "./summon-decision-clock-do";
export { RelaySpaceDeletionClock } from "./space-deletion-clock-do";
export { RelayPageSession } from "./page-session-do";
export { RelayPostgresChannelCoordinator } from "./relay-postgres-channel-coordinator-do";
export { RelayPostgresAgentLaunchChannel } from "./postgres-agent-launch-channel-do";
export { GitHubSubscriptionIndex } from "./github-subscription-index";
export { RelayXUploadExecutor } from "./connectors/x-upload-executor-do";
export { RelayPostgresBackgroundAdmission } from "./postgres-background-admission-do";
export {
  RelayAgentAppPolicyAuthority,
  RelayAgentAppPolicyLocator,
  RelayChannelCatalogAuthority,
  RelayChannelFamilyData,
  RelayChannelFamilyDirectory,
  RelayControlPlaneDirectory,
  RelayGlobalDirectoryAuthority,
  RelayProjectionAuthorizationAuthority,
  RelayRankAuthorityDirectory,
  RelayRuntimeChannelFanout,
  RelayRuntimeRouteDirectory,
  RelaySchedulerAuthority,
  RelayScopedControlAuthority,
  RelaySpaceCapacityAuthority,
  RelaySpaceMembershipAuthority,
  RelaySpaceProjection,
  RelaySpaceRootAuthority,
  RelayTraceAccessAuthority,
  RelayTraceAccessLocator,
  RelayTraceAccessUserIndex,
  RelayUserPreferenceAuthority,
} from "./retained-fact-namespaces";
export { RelayRuntimeLive } from "./relay-runtime";
import { runAsDeliveryInvocation } from "./runtime-transport/runtime-principal-delivery";
export { DeviceAuthBroker } from "./device-auth";
import { registerIndexRoutesAdmin } from "./index-routes-admin";
import { registerIndexRoutesAuthSpace } from "./index-routes-auth-space";
import { registerIndexRoutesAutomation } from "./index-routes-automation";
import { registerIndexRoutesSpaceJoinRequests } from "./index-routes-space-join-requests";
import { registerIndexRoutesChannelAgent } from "./index-routes-channel-agent";
import { registerIndexRoutesHumanProfile } from "./index-routes-human-profile";
import { registerAppSignInRoutes } from "./index-routes-app-sign-in";
import { countAuthMetricsIn } from "./auth-observability";
import { registerAuthSessionRoutes } from "./index-routes-auth-sessions";
import { registerIndexRoutesHumanAvatar } from "./index-routes-human-avatar";
import { registerFaceRoutes } from "./index-routes-faces";
import { registerIndexRoutesMachineDaemonAdmission } from "./index-routes-machine-daemon-admission";
import { registerIndexRoutesAppleBilling } from "./index-routes-apple-billing";
import { registerIndexRoutesGooglePlayBilling } from "./index-routes-google-play-billing";
import { registerIndexRoutesPush } from "./index-routes-push";
import { registerIndexRoutesBilling } from "./index-routes-billing";
import { registerIndexRoutesJev } from "./index-routes-jev";
import { registerSearchRerankRoutes } from "./index-routes-search-rerank";
import { registerClientCompatibilityGate } from "./client-compatibility-gate";
import { registerDirectReadCors } from "./direct-read-cors";
import { registerRequestBodyLimit } from "./request-body-limit";
import { registerRequestRateLimit } from "./request-rate-limit";
import { registerIndexRoutesPostgresReadiness } from "./postgres-readiness";
import { registerCliCommandRoutes } from "./index-routes-cli-commands";
import { registerNornRequestRoutes } from "./index-routes-norn-requests";

const app = new Hono<{ Bindings: Env }>();
// A failure no route answered still gets the one error contract: a transient
// outage as a retryable 503, anything else as a reported JSON 500. Hono's
// default is a plain-text 500 that no client can tell from a defect.
app.onError((error, c) => error instanceof HTTPException ? error.getResponse() : requestErrorResponse(c, error));
registerRequestRateLimit(app);
registerRequestBodyLimit(app);
// Before the compatibility gate, so its refusal of a direct read reaches the app too.
registerDirectReadCors(app);
registerClientCompatibilityGate(app);
registerIndexRoutesPostgresReadiness(app);
registerIndexRoutesAdmin(app);
// Before the sign-in library's own /api/auth/* routes.
registerAppSignInRoutes(app);
registerIndexRoutesAuthSpace(app);
registerIndexRoutesMachineDaemonAdmission(app);
registerIndexRoutesBilling(app);
registerIndexRoutesAppleBilling(app);
registerIndexRoutesGooglePlayBilling(app);
registerIndexRoutesPush(app);
registerIndexRoutesJev(app);
registerSearchRerankRoutes(app);
registerIndexRoutesAutomation(app);
registerCliCommandRoutes(app);
registerNornRequestRoutes(app);
registerIndexRoutesSpaceJoinRequests(app);
registerIndexRoutesChannelAgent(app);
registerPageRoutes(app);
registerPageProgramRoutes(app);
registerPageMigrationRoutes(app);
registerGovernanceRoutes(app);
registerPageGitRoutes(app);
registerMcpRoutes(app);
registerCrossSpaceReadRoutes(app);
registerSecretRoutes(app);
registerConnectorRoutes(app);
registerConnectorOAuthRoutes(app);
registerMailSnapshotRoutes(app);
registerGooglePickerRoutes(app);
registerGmailMailboxRoutes(app);
registerCloudflareLoginRoutes(app);
registerStripeAccountRoutes(app);
registerSentryInstallationRoutes(app);
registerChannelTransferRoutes(app);
registerMachineNameRoutes(app);
registerMachineResourceRoutes(app);
registerMachineRetirementRoutes(app);
registerHarnessActionRoutes(app);
registerHarnessSignInRequestRoutes(app);
registerSettingsRequestRoutes(app);
registerWorktreeActionRoutes(app);
registerCliUpdateCheckRoutes(app);
registerSetupIntentRoutes(app);
registerWelcomeRoutes(app);
registerOnboardingFunnelRoutes(app);
registerIndexRoutesHumanProfile(app);
registerAuthSessionRoutes(app);
registerIndexRoutesHumanAvatar(app);
registerFaceRoutes(app);
registerAccountDeletionRoutes(app);

export default {
  // An invocation's live deliveries share one subrequest budget (runtime-principal-delivery.ts).
  fetch: (request: Request, env: Env, executionCtx: ExecutionContext) => runAsDeliveryInvocation(async () => {
    countAuthMetricsIn(env.DIAGNOSTICS_AE);
    try {
      return await (redirectInsecureRequest(request) ?? app.fetch(request, env, executionCtx));
    } finally {
      executionCtx.waitUntil(sendErrorReports());
    }
  }),
  scheduled: (event: ScheduledController, env: Env, executionCtx: ExecutionContext) => runAsDeliveryInvocation(async () => {
    if (event.cron === "*/5 * * * *") {
      executionCtx.waitUntil(drainAppleCommerce(env).catch(error => scheduledTaskFailed("Apple commerce recovery",error)).finally(sendErrorReports));
      return;
    }
    // The passes run beside PostgreSQL, in the Runtime cell (scheduled-minute.ts).
    executionCtx.waitUntil(runMinutePassesBesidePostgres(env, event.scheduledTime)
      .catch(error => scheduledTaskFailed("Scheduled minute", error)).finally(sendErrorReports));
  }),
  queue: (batch: MessageBatch<unknown>) => ackRetiredExportQueue(batch),
} satisfies ExportedHandler<Env>;
