import type { GmailRoutingJob } from "@xmatrix/db";
import type { Env } from "../types";
import { dispatchProductMessageAppend } from "../product-message-append";
import { fireConnectorAutomationTriggers } from "../automation-triggers";
import { connectorCredentialRepository, gmailRoutingRepository } from "./credentials";
import { parseMailboxes } from "./gmail-mailboxes";
import { gmailWatchIdentity,gmailWatchToken,renewGmailWatch,verifyGmailWatchMailbox } from "./gmail-watch-client";
import { gmailIncomingChanges } from "./gmail-notification-api";
import { ProviderRequestError } from "./http";

/** Reads only IDs, then delivers opaque references. No Gmail content enters messages. */
async function deliver(env: Env, job: GmailRoutingJob, id: string) {
  const repository = gmailRoutingRepository(env);
  if (!await repository.current(job)) throw new ProviderRequestError(409,"Mailbox access changed");
  const eventId = `${job.id}:${id}`;
  const event = { eventId, sourceRef: `gmail:${job.id}`, feature: "message.received",
    summary: "A new Gmail message is available", body: `A new Gmail message is available. Read it with @gmail:read:${id}.` };
  const response = await dispatchProductMessageAppend(env, job.channelId, { commandId: `product:gmail:${eventId}`,
    messageId: `app:gmail:${eventId}`, channelId: job.channelId, body: event.body,
    principal: { kind: "user", id: job.userId }, appAuthorId: "gmail" });
  if (!response.ok) throw new ProviderRequestError(503,"Notification delivery failed");
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
  if (job.selection.appIdentity!==await gmailWatchIdentity(env) || !job.selection.refreshToken) return "blocked" as const;
  const token=await gmailWatchToken(env,{grant_type:"refresh_token",refresh_token:job.selection.refreshToken},false);
  if(job.renewAt && Date.parse(job.renewAt)<=Date.now()) {
    await verifyGmailWatchMailbox(token.accessToken,job.selection.address);
    const renewal=await renewGmailWatch(env,token.accessToken);
    await repository.renewed(job,renewal.expiresAt);
    // The new watch head never overwrites the last consumed history cursor.
  }
  if(!job.pendingWake)return "done" as const;
  for (const id of await repository.pending(job)) await deliver(env,job,id);
  let change: Awaited<ReturnType<typeof gmailIncomingChanges>>;
  try {change=await gmailIncomingChanges(token.accessToken,job.historyId,job.pageToken);}
  catch(error) {
    if(!(error instanceof ProviderRequestError) || error.status!==404)throw error;
    // Expired history cannot safely identify missed mail. Establish a fresh baseline,
    // explicitly disclose the gap, and never replay older emails as new events.
    const fresh=await renewGmailWatch(env,token.accessToken);
    if(!await repository.current(job))return "blocked" as const;
    const response=await dispatchProductMessageAppend(env,job.channelId,{
      commandId:`product:gmail-gap:${job.id}:${job.historyId}`,messageId:`app:gmail-gap:${job.id}:${job.historyId}`,
      channelId:job.channelId,principal:{kind:"user",id:job.userId},appAuthorId:"gmail",
      body:"Gmail notification history expired. Listening has resumed; some emails during the gap may not have triggered a notification. Search the mailbox to review them."});
    if(!response.ok)throw new ProviderRequestError(503,"Notification recovery receipt failed");
    if(!await repository.current(job))return "blocked" as const;
    await repository.stage(job,[],fresh.historyId);
    await repository.renewed(job,fresh.expiresAt);
    return "done" as const;
  }
  if (!await repository.current(job)) return "blocked" as const;
  await repository.stage(job, change.messages, change.historyId, change.pageToken);
  for (const id of await repository.pending(job)) await deliver(env,job,id);
  // Keep paging/retrying durably; do not advance the start cursor until the final page.
  return change.pageToken || (await repository.pending(job)).length ? "continue" as const : "done" as const;
}
/** A bounded pass runs after a receipt, and the existing cron recovers unfinished durable work. */
export async function drainGmailNotifications(env: Env) {
  if (!env.GMAIL_WATCH_TOPIC) return;
  const repository = gmailRoutingRepository(env);
  await repository.cleanup();
  for (const job of await repository.claim()) {
    try { await repository.finish(job, await process(env,job)); }
    catch (error) {
      // 403 may be Gmail quota throttling; lease loss and delivery conflicts also retry.
      // Only definitive authorization failure retires the native grant.
      const revoked=error instanceof ProviderRequestError && error.status===401;
      if(revoked && await repository.current(job)) {
        const response=await dispatchProductMessageAppend(env,job.channelId,{
          commandId:`product:gmail-stopped:${job.id}`,messageId:`app:gmail-stopped:${job.id}`,
          channelId:job.channelId,principal:{kind:"user",id:job.userId},appAuthorId:"gmail",
          body:"Gmail notifications need attention. Authorize notifications again in Apps → Gmail; existing search, read and reply remain available."});
        if(!response.ok) {await repository.finish(job,"retry");continue;}
      }
      await repository.finish(job,revoked ? "blocked" : "retry");
    }
  }
}
