import type { SentryEventJob } from "@xmatrix/db";
import { sha256Hex } from "@xmatrix/protocol";
import { fireConnectorAutomationTriggers } from "../automation-triggers";
import { dispatchProductMessageAppend } from "../product-message-append";
import type { Env } from "../types";
import { connectorAppRepository, connectorCredentialRepository, connectorSentryEventRepository } from "./credentials";
import { connectionCredentials } from "./connection-credentials";
import { connectorEvent, record } from "./event-format";
import { deliverEvent } from "./event-ingress";
import { providerJson } from "./http";
import { sentryInstallationClient, validateSentryInstallationCredentials, verifySentryInstallation } from "./sentry-installation";

export interface SentryDrainDependencies {
  receipts: typeof connectorSentryEventRepository;
  credentials: typeof connectorCredentialRepository;
  refresh: typeof connectionCredentials;
  verify: typeof verifySentryInstallation;
  request: typeof providerJson;
  apps: typeof connectorAppRepository;
  append: typeof dispatchProductMessageAppend;
  automations: typeof fireConnectorAutomationTriggers;
}
const defaults: SentryDrainDependencies = { receipts: connectorSentryEventRepository, credentials: connectorCredentialRepository,
  refresh: connectionCredentials, verify: verifySentryInstallation, request: providerJson, apps: connectorAppRepository,
  append: dispatchProductMessageAppend, automations: fireConnectorAutomationTriggers };
const ISSUE_FEATURES: Record<string, string> = { created: "issue.created", resolved: "issue.resolved", unresolved: "issue.regressed",
  assigned: "issue.assigned", ignored: "issue.ignored", archived: "issue.ignored" };

/** Bounded, durable claim. Both post-commit wake and minute recovery use this same primary App owner. */
export async function drainSentryEvents(env: Env, dependencies: SentryDrainDependencies = defaults): Promise<void> {
  const client = sentryInstallationClient(env);
  if (!client) return;
  const receipts = dependencies.receipts(env);
  const jobs = await receipts.claim({ requestId: crypto.randomUUID(), appClientId: client.clientId, appUuid: client.appUuid });
  // A refresh replaces the installation's only token, so parallel jobs share one refresh per Space.
  const refreshes = new Map<string, ReturnType<typeof connectionCredentials>>();
  const shared: SentryDrainDependencies = { ...dependencies, refresh: (refreshEnv, spaceId, providerId) => {
    if (!refreshes.has(spaceId)) refreshes.set(spaceId, dependencies.refresh(refreshEnv, spaceId, providerId));
    return refreshes.get(spaceId)!;
  } };
  await Promise.all(jobs.map(async job => {
    let outcome: "done" | "obsolete" | "retry" = "retry";
    try {
      outcome = await deliverSentryJob(env, job, shared) ? "done" : "obsolete";
    } catch {
      // Never log provider error strings, private responses, identities or credentials.
      console.error("Sentry event attempt failed");
    }
    await receipts.finish({ ...job, requestId: crypto.randomUUID(), outcome });
  }));
}

async function deliverSentryJob(env: Env, job: SentryEventJob, dependencies: SentryDrainDependencies): Promise<boolean> {
  const receipts = dependencies.receipts(env);
  const current = () => receipts.current({ ...job, requestId: crypto.randomUUID() });
  if (!await current()) return false;
  // A refresh persists its complete rotated pair. It cannot create a new grant generation.
  await dependencies.refresh(env, job.spaceId, "sentry");
  const binding = await current();
  if (!binding) return false;
  const resolved = await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(), spaceId: job.spaceId, providerId: "sentry" });
  if (!resolved || resolved.connectionId !== job.connectionId || resolved.status !== "configured" || resolved.version !== binding.credentialVersion) {
    throw new Error("Sentry grant changed during drain");
  }
  const fields = resolved.values;
  validateSentryInstallationCredentials(fields);
  if (fields.oauthClientId !== job.appClientId || fields.oauthAppUuid !== job.appUuid || fields.oauthInstallationId !== job.installationId) return false;
  await dependencies.verify(fields);
  const identity = job.identity;
  if ((identity.organizationId && identity.organizationId !== fields.oauthOrganizationId) ||
      (identity.organizationSlug && identity.organizationSlug !== fields.oauthOrganization)) return false;
  const projects = identity.projects ?? [identity.projectSlug!];
  // Current installed token must prove each named project in the verified organization.
  // URLs are built from typed references; no signed or unsigned payload URL is fetched.
  for (const slug of projects) {
    const project = await dependencies.request(`https://sentry.io/api/0/projects/${encodeURIComponent(fields.oauthOrganization!)}/${encodeURIComponent(slug)}/`,
      { headers: { authorization: `Bearer ${fields.oauthToken}` } });
    const organization = record(project.organization);
    if (project.slug !== slug || String(organization.id) !== fields.oauthOrganizationId ||
        organization.slug !== fields.oauthOrganization || (identity.projectId && String(project.id) !== identity.projectId)) return false;
  }
  for (const slug of projects) {
    const fresh = await current();
    if (!fresh) return false;
    // Provider proof used exactly this token version. A concurrent rotation retries before effects.
    if (fresh.credentialVersion !== resolved.version) throw new Error("Sentry credentials changed during provider proof");
    const feature = identity.kind === "issue" ? ISSUE_FEATURES[identity.action]! : "alert";
    const subject = identity.kind === "issue" ? `Issue ${identity.objectId}` : identity.kind === "event_alert" ?
      `Event alert ${identity.objectId}` : `Metric alert ${identity.objectId}`;
    const url = identity.kind === "issue" ? `https://sentry.io/organizations/${fields.oauthOrganization}/issues/${identity.objectId}/` :
      identity.kind === "event_alert" ? `https://sentry.io/organizations/${fields.oauthOrganization}/issues/?project=${identity.projectId}&query=${identity.objectId}` :
        `https://sentry.io/organizations/${fields.oauthOrganization}/alerts/`;
    const event = connectorEvent({ eventId: await sha256Hex(`${job.deliveryDigest}:${slug}`), sourceRef: `sentry:${slug}`,
      feature, summary: `${subject} ${identity.action}`, provider: `Sentry · ${slug}`, title: `${subject} ${identity.action}`, url });
    const append: typeof dispatchProductMessageAppend = async (...args) => {
      const live = await current();
      if (!live || live.credentialVersion !== resolved.version) return new Response(null, { status: 503 });
      return dependencies.append(...args);
    };
    await deliverEvent(env, dependencies.apps(env), append, "sentry", job.connectionId, event, {
      providerId: "sentry", appClientId: job.appClientId, installationId: job.installationId,
      credentialVersion: fresh.credentialVersion, grantGeneration: job.grantGeneration });
    const automationGrant = await current();
    if (!automationGrant) return false;
    if (automationGrant.credentialVersion !== resolved.version) throw new Error("Sentry credentials changed before Automation delivery");
    // Failure remains durable retry work; already committed Channel/Automation ids make repeats safe.
    await dependencies.automations(env, { spaceId: job.spaceId, provider: "sentry", event });
  }
  return true;
}
