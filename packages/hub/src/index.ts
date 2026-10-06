// First, so that error reporting is open before anything else loads.
import "./error-reporting";
import { reportError, sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { drainSentryEvents } from "./connectors/sentry-event-drain";
import { watchHarnessReleases } from "./harness-release-watch";
import { connectorGoogleChatRoomRepository, connectorFeishuRoomRepository, connectorTelegramRoomRepository, connectorTeamsRoomRepository } from "./connectors/credentials";
import { ackRetiredExportQueue } from "./retired-export-queue";
import { registerMachineNameRoutes } from "./index-routes-machine-name";
import { registerMachineRetirementRoutes } from "./index-routes-machine-retirement";
import { registerHarnessActionRoutes } from "./index-routes-harness-actions";
import { registerChannelTransferRoutes } from "./index-routes-channel-transfer";
import { registerPageRoutes } from "./index-routes-pages";
import { registerPageAutomationRoutes } from "./index-routes-page-automations";
import { registerPageMigrationRoutes } from "./index-routes-page-migration";
import { registerGovernanceRoutes } from "./index-routes-governance";
import { registerPageGitRoutes } from "./index-routes-page-git";
import { registerCrossSpaceReadRoutes } from "./cross-space-read";
import { registerSecretRoutes } from "./index-routes-secrets";
import { registerConnectorRoutes } from "./index-routes-connectors";
import { registerConnectorOAuthRoutes } from "./index-routes-connector-oauth";
import { registerSentryInstallationRoutes } from "./index-routes-sentry-installation";
import { registerGooglePickerRoutes } from "./index-routes-google-picker";
import { redirectInsecureRequest } from "./https-redirect";
import { retryablePostgresFailure } from "./postgres-error-classification";
import { Hono } from "hono";
import type { Env } from "./types";
export { RelaySummonDecisionClock } from "./summon-decision-clock-do";
export { RelaySpaceDeletionClock } from "./space-deletion-clock-do";
export { RelayPageSession } from "./page-session-do";
export { RelayPostgresChannelCoordinator } from "./relay-postgres-channel-coordinator-do";
export { RelayPostgresAgentLaunchChannel } from "./postgres-agent-launch-channel-do";
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
export { RelayRuntimeRouteDirectory } from "./runtime-route-directory";
export { DeviceAuthBroker } from "./device-auth";
import { registerIndexRoutesAdmin } from "./index-routes-admin";
import { registerIndexRoutesAuthSpace } from "./index-routes-auth-space";
import { registerIndexRoutesAutomation } from "./index-routes-automation";
import { registerIndexRoutesSpaceJoinRequests } from "./index-routes-space-join-requests";
import { registerIndexRoutesChannelAgent } from "./index-routes-channel-agent";
import { registerIndexRoutesHumanProfile } from "./index-routes-human-profile";
import { registerIndexRoutesHumanAvatar } from "./index-routes-human-avatar";
import { registerIndexRoutesMachineDaemonAdmission } from "./index-routes-machine-daemon-admission";
import { registerIndexRoutesBilling } from "./index-routes-billing";
import { registerIndexRoutesJev } from "./index-routes-jev";
import { registerClientCompatibilityGate } from "./client-compatibility-gate";
import { registerRequestBodyLimit } from "./request-body-limit";
import { registerRequestRateLimit } from "./request-rate-limit";
import { registerIndexRoutesPostgresReadiness } from "./postgres-readiness";

const app = new Hono<{ Bindings: Env }>();
registerRequestRateLimit(app);
registerRequestBodyLimit(app);
registerClientCompatibilityGate(app);
registerIndexRoutesPostgresReadiness(app);
registerIndexRoutesAdmin(app);
registerIndexRoutesAuthSpace(app);
registerIndexRoutesMachineDaemonAdmission(app);
registerIndexRoutesBilling(app);
registerIndexRoutesJev(app);
registerIndexRoutesAutomation(app);
registerIndexRoutesSpaceJoinRequests(app);
registerIndexRoutesChannelAgent(app);
registerPageRoutes(app);
registerPageAutomationRoutes(app);
registerPageMigrationRoutes(app);
registerGovernanceRoutes(app);
registerPageGitRoutes(app);
registerCrossSpaceReadRoutes(app);
registerSecretRoutes(app);
registerConnectorRoutes(app);
registerConnectorOAuthRoutes(app);
registerGooglePickerRoutes(app);
registerSentryInstallationRoutes(app);
registerChannelTransferRoutes(app);
registerMachineNameRoutes(app);
registerMachineRetirementRoutes(app);
registerHarnessActionRoutes(app);
registerIndexRoutesHumanProfile(app);
registerIndexRoutesHumanAvatar(app);

export default {
  fetch: async (request: Request, env: Env, executionCtx: ExecutionContext) => {
    try {
      return await (redirectInsecureRequest(request) ?? app.fetch(request, env, executionCtx));
    } finally {
      executionCtx.waitUntil(sendErrorReports());
    }
  },
  scheduled: (_event: ScheduledController, env: Env, executionCtx: ExecutionContext) => {
    const run = (name: string, work: () => Promise<unknown>) => executionCtx.waitUntil(
      Promise.resolve().then(work).catch((error: unknown) => scheduledTaskFailed(name, error)).finally(sendErrorReports));
    run("Sentry event recovery", () => drainSentryEvents(env));
    run("Harness release watch", () => watchHarnessReleases(env));
    for (const [provider, repository] of [["Teams", connectorTeamsRoomRepository], ["Google Chat", connectorGoogleChatRoomRepository], ["Feishu", connectorFeishuRoomRepository], ["Telegram", connectorTelegramRoomRepository]] as const) {
      run(`${provider} lifecycle maintenance`, () => repository(env).cleanup({ requestId: crypto.randomUUID(), limit: 100 }));
    }
  },
  queue: (batch: MessageBatch<unknown>) => ackRetiredExportQueue(batch),
} satisfies ExportedHandler<Env>;

/** A failed cron task names its cause; a database outage is logged, a defect is also reported. */
function scheduledTaskFailed(name: string, error: unknown): void {
  console.error(`${name} failed`, error);
  if (!retryablePostgresFailure(error)) reportError(error);
}
