import type { GmailRoutingJob } from "@xmatrix/db";
import type { Env } from "../types";
import { dispatchProductMessageAppend } from "../product-message-append";
import { fireConnectorAutomationTriggers } from "../automation-triggers";
import { connectorAppRepository, connectorCredentialRepository, gmailRoutingRepository } from "./credentials";
import { appendToRoutes } from "./event-ingress";
import type { ConnectorEvent } from "./provider";
import { parseMailboxes } from "./gmail-mailboxes";
import { gmailWatchIdentity,gmailWatchToken,renewGmailWatch,verifyGmailWatchMailbox } from "./gmail-watch-client";
import { gmailIncomingChanges } from "./gmail-notification-api";
import { ProviderRequestError } from "./http";
import { gmailPollConfig,gmailPollIdentity,gmailPollToken,gmailInboxFingerprint,
  gmailComposioBaseline,gmailComposioNotificationGet } from "./gmail-poll-client";

/* Like any connector event, a notification goes to the Channels subscribed to
   its mailbox (`@gmail:subscribe:<mailbox>` or `*`). A mailbox is private to its
   member, so only subscriptions that member or their Agents made receive it. */
async function post(env: Env, job: GmailRoutingJob, event: ConnectorEvent, feature?: string) {
  const apps = connectorAppRepository(env);
  const groups = await Promise.all([`gmail:${job.selection.address}`, "gmail:*"].map(sourceRef => apps.connectorEventRoutes({
    requestId: crypto.randomUUID(), connectionId: job.connectionId, sourceRef, limit: 100 })));
  const routes = new Map<string, (typeof groups)[number][number]>();
  for (const route of groups.flat()) {
    if (route.authorityRootUserId === job.userId && (!feature || route.features.includes(feature)) && !routes.has(route.channelId))
      routes.set(route.channelId, route);
  }
  try { await appendToRoutes(env, dispatchProductMessageAppend, "gmail", event, [...routes.values()]); }
  catch { throw new ProviderRequestError(503, "Notification delivery failed"); }
}
function notice(job: GmailRoutingJob, eventId: string, body: string): ConnectorEvent {
  return { eventId, sourceRef: `gmail:${job.selection.address}`, feature: "notice", summary: body, body };
}
/** Reads only IDs, then delivers opaque references. No Gmail content enters messages. */
async function deliver(env: Env, job: GmailRoutingJob, id: string) {
  const repository = gmailRoutingRepository(env);
  if (!await repository.current(job)) throw new ProviderRequestError(409,"Mailbox access changed");
  const event = { eventId: `${job.id}:${id}`, sourceRef: `gmail:${job.selection.address}`, feature: "message.received",
    summary: "A new Gmail message is available",
    body: `A new Gmail message is available in ${job.selection.address}. Read it with @gmail:read:${id}.` };
  await post(env, job, event, event.feature);
  if (!await repository.current(job)) throw new ProviderRequestError(409,"Mailbox access changed");
  await fireConnectorAutomationTriggers(env, { spaceId: job.spaceId, provider: "gmail", event, authorizedUserId: job.userId });
  await repository.delivered(job,id);
}
async function process(env: Env, job: GmailRoutingJob) {
  const repository = gmailRoutingRepository(env);
  if (!await repository.current(job)) return "blocked" as const;
  const grant = await connectorCredentialRepository(env).resolve({ requestId: crypto.randomUUID(), spaceId: job.spaceId, providerId: "gmail" });
  const mailbox = grant?.values.mailboxes ? parseMailboxes(grant.values.mailboxes).find(row => row.account === job.selection.account &&
    row.address === job.selection.address && row.owner === job.selection.owner && row.owner === `user:${job.userId}`) : undefined;
  if (!grant || grant.version !== job.credentialVersion || grant.connectionGeneration !== job.generation || !mailbox) return "blocked" as const;
  if (!job.selection.refreshToken) return "blocked" as const;
  let accessToken="";
  if(job.mode==="poll") {
    if(job.selection.appIdentity!==await gmailPollIdentity(env))return "blocked" as const;
    let token=job.selection.pollToken;
    if(!token || token.expiresAt<Date.now()+120000) {
      const refreshed=await gmailPollToken(env,{grant_type:"refresh_token",refresh_token:job.selection.refreshToken},false);
      token={accessToken:refreshed.accessToken,expiresAt:refreshed.expiresAt};
      await repository.cachePollToken(job,token,refreshed.refreshToken);
    }
    await repository.polled(job,await gmailInboxFingerprint(token.accessToken));
    if(!job.pendingWake && !job.pageToken && job.nextSearchAt && Date.parse(job.nextSearchAt)>Date.now())return "done" as const;
  } else {
    if(job.selection.appIdentity!==await gmailWatchIdentity(env))return "blocked" as const;
    const token=await gmailWatchToken(env,{grant_type:"refresh_token",refresh_token:job.selection.refreshToken},false);
    accessToken=token.accessToken;
    if(job.renewAt && Date.parse(job.renewAt)<=Date.now()) {
      await verifyGmailWatchMailbox(accessToken,job.selection.address);
      const renewal=await renewGmailWatch(env,accessToken);
      await repository.renewed(job,renewal.expiresAt);
      // The new watch head never overwrites the last consumed history cursor.
    }
    if(!job.pendingWake)return "done" as const;
  }
  for (const id of await repository.pending(job)) await deliver(env,job,id);
  let change: Awaited<ReturnType<typeof gmailIncomingChanges>>;
  try {change=await gmailIncomingChanges(accessToken,job.historyId,job.pageToken,job.mode==="poll" ?
    query=>gmailComposioNotificationGet(env,job.selection.account,job.spaceId,"/history",query) : undefined);}
  catch(error) {
    if(!(error instanceof ProviderRequestError) || error.status!==404)throw error;
    // Expired history cannot safely identify missed mail. Establish a fresh baseline,
    // explicitly disclose the gap, and never replay older emails as new events.
    const fresh=job.mode==="poll" ? {historyId:await gmailComposioBaseline(env,job.selection.account,job.spaceId,job.selection.address)} :
      await renewGmailWatch(env,accessToken);
    if(!await repository.current(job))return "blocked" as const;
    await post(env,job,notice(job,`gap:${job.id}:${job.historyId}`,`${job.selection.address}: Gmail notification history expired. Listening has resumed; some emails during the gap may not have triggered a notification. Search the mailbox to review them.`));
    if(!await repository.current(job))return "blocked" as const;
    await repository.stage(job,[],fresh.historyId);
    if("expiresAt" in fresh)await repository.renewed(job,fresh.expiresAt);
    else await repository.searched(job);
    return "done" as const;
  }
  if (!await repository.current(job)) return "blocked" as const;
  await repository.stage(job, change.messages, change.historyId, change.pageToken);
  for (const id of await repository.pending(job)) await deliver(env,job,id);
  // Keep paging/retrying durably; do not advance the start cursor until the final page.
  if(change.pageToken || (await repository.pending(job)).length)return "continue" as const;
  if(job.mode==="poll")await repository.searched(job);
  return "done" as const;
}
/** A bounded pass runs after a receipt, and the existing cron recovers unfinished durable work. */
export async function drainGmailNotifications(env: Env) {
  if (!env.GMAIL_WATCH_TOPIC && !gmailPollConfig(env)) return;
  const repository = gmailRoutingRepository(env);
  await repository.cleanup();
  const jobs=await repository.claim();
  const run=async(job:GmailRoutingJob)=>{
    try { await repository.finish(job, await process(env,job)); }
    catch (error) {
      // 403 may be Gmail quota throttling; lease loss and delivery conflicts also retry.
      // Only definitive authorization failure retires the native grant.
      const revoked=error instanceof ProviderRequestError && error.status===401;
      if(revoked && await repository.current(job)) {
        try {await post(env,job,notice(job,`stopped:${job.id}`,`${job.selection.address}: Gmail notifications need attention. Turn notifications on again in Apps → Gmail; existing search, read and reply remain available.`));}
        catch {await repository.finish(job,"retry");return;}
      }
      await repository.finish(job,revoked ? "blocked" : "retry");
    }
  };
  for(let offset=0;offset<jobs.length;offset+=4)await Promise.all(jobs.slice(offset,offset+4).map(run));
}
