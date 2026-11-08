import type { AppleCommerceState, AppleCommerceJob, AppleCommerceChange } from "@xmatrix/db";
import type { Env } from "../types";
import { dispatchProductMessageAppend } from "../product-message-append";
import { fireConnectorAutomationTriggers } from "../automation-triggers";
import { appStoreConnect, appleApp, appleResource, type AppStoreConnectApi, type AppleResource } from "./app-store-connect-api";
import { appleCommerceRepository, connectorCredentialRepository } from "./credentials";
import { appendToRoutes } from "./event-ingress";
import { connectorEvent, record, text } from "./event-format";
import { appOnly } from "./app-store-connect-web";
import type { ConnectorAction } from "./provider";
import { ProviderRequestError } from "./http";

/** A complete bounded collection, never the truncated result of a page cap. */
async function collection(api: AppStoreConnectApi, path: string, type: string) {
  const rows: AppleResource[] = [], visited = new Set<string>();
  let next = path;
  const original = new URL(path,"https://api.appstoreconnect.apple.com");
  for (let page = 0; page < 3; page++) {
    if (visited.has(next)) throw new ProviderRequestError(502, "Apple repeated a commerce page");
    visited.add(next);
    const response = await api.request(next);
    if (!Array.isArray(response.data) || response.data.length > 200) throw new ProviderRequestError(502, "Invalid Apple commerce collection");
    for (const data of response.data) {
      const row = appleResource(data);
      if (!row || row.type !== type || !/^[A-Za-z0-9-]{1,100}$/u.test(row.id)) throw new ProviderRequestError(502, "Apple omitted commerce resource identity");
      rows.push(row);
    }
    const link = record(response.links).next;
    if (link == null) return rows;
    if (typeof link !== "string" || !link) throw new ProviderRequestError(502, "Invalid Apple commerce pagination");
    const destination = new URL(link,"https://api.appstoreconnect.apple.com");
    if (destination.origin !== original.origin || destination.pathname !== original.pathname || destination.username || destination.password || destination.hash ||
      [...original.searchParams].some(([key,value]) => destination.searchParams.get(key) !== value) ||
      [...destination.searchParams.keys()].some(key => key !== "cursor" && !original.searchParams.has(key))) {
      throw new ProviderRequestError(502,"Apple returned a commerce page outside its scoped collection");
    }
    next = destination.href;
  }
  throw new ProviderRequestError(502, "Apple commerce history exceeds its page bound; snapshot unchanged");
}

/** Public product states are the account's current commerce review state. */
export async function readAppleCommerceStates(api: AppStoreConnectApi, appId: string): Promise<AppleCommerceState[]> {
  const root = `/v1/apps/${encodeURIComponent(appId)}`;
  const groups = await collection(api, `${root}/subscriptionGroups?fields[subscriptionGroups]=referenceName&limit=200`, "subscriptionGroups");
  if (groups.length > 20) throw new ProviderRequestError(502, "Commerce polling supports at most 20 subscription groups per app");
  const result: AppleCommerceState[] = [], seen = new Set<string>();
  const add = (kind: AppleCommerceState["kind"], rows: AppleResource[]) => {
    for (const row of rows) {
      const state = text(row.attributes.state), id = `${kind}:${row.id}`;
      if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(state) || seen.has(id)) throw new ProviderRequestError(502, "Ambiguous Apple commerce state");
      seen.add(id); result.push({ kind, id: row.id, state });
      if (result.length > 500) throw new ProviderRequestError(502, "Commerce polling exceeds 500 products; snapshot unchanged");
    }
  };
  for (const group of groups) add("subscription", await collection(api,
    `/v1/subscriptionGroups/${encodeURIComponent(group.id)}/subscriptions?fields[subscriptions]=state&limit=200`, "subscriptions"));
  add("inAppPurchase", await collection(api, `${root}/inAppPurchasesV2?fields[inAppPurchases]=state&limit=200`, "inAppPurchases"));
  return result;
}
function event(job: AppleCommerceJob, change: AppleCommerceChange) {
  const bundle = job.sourceRef.slice("appstoreconnect:".length);
  return connectorEvent({ eventId: `commerce:${job.watchId}:${change.sequence}`, sourceRef: job.sourceRef,
    feature: "commerce", summary: `${bundle}: ${change.kind} ${change.id} ${change.previous} → ${change.state}`,
    provider: `App Store Connect · ${bundle}`, title: `${change.kind} review state ${change.previous} → ${change.state}`,
    details: [`Apple product id: ${change.id}. Read subscriptions or in_app_purchases for product names.`] });
}
async function process(env: Env, job: AppleCommerceJob) {
  const repository = appleCommerceRepository(env);
  if (!await repository.current(job)) return;
  const grant = await connectorCredentialRepository(env).resolve({ requestId: crypto.randomUUID(), spaceId: job.spaceId, providerId: "appstoreconnect" });
  if (!grant || grant.version !== job.credentialVersion || grant.connectionGeneration !== job.generation) return;
  let pending = job.pending;
  if (!pending.length) {
    const api = appStoreConnect(grant.values), app = await appleApp(api, job.sourceRef.slice("appstoreconnect:".length));
    pending = await repository.stage(job, await readAppleCommerceStates(api, app.id));
  }
  for (const change of pending.slice(0, 10)) {
    if (!await repository.current(job)) return;
    const route = await repository.route(job);
    if (!route) return;
    const notice = event(job,change);
    await appendToRoutes(env,dispatchProductMessageAppend,"appstoreconnect",notice,[route]);
    if (!await repository.current(job)) return;
    await fireConnectorAutomationTriggers(env,{ spaceId: job.spaceId,provider:"appstoreconnect",event:notice,authorizedUserId:job.userId });
    await repository.delivered(job,change.sequence);
  }
  return pending.length > 10;
}

/** Independent cron invocation keeps provider polling out of the maintenance invocation's connection budget. */
export async function drainAppleCommerce(env: Env) {
  const repository = appleCommerceRepository(env), jobs = await repository.claim();
  let failures = 0;
  for (let offset = 0; offset < jobs.length; offset += 4) {
    const results = await Promise.allSettled(jobs.slice(offset,offset+4).map(async job => {
      let retry = true;
      try { retry = Boolean(await process(env,job)); }
      finally { await repository.finish(job,retry); }
    }));
    failures += results.filter(result => result.status === "rejected").length;
  }
  if (failures) throw new ProviderRequestError(503,`${failures} Apple commerce watches will retry; no snapshot or pending event was discarded`);
}

export function appleCommerceStatusCapability(env:Env,scope:{spaceId:string;channelId:string;userId:string}) {
  return { async status(bundleId:string) {
    const state=await appleCommerceRepository(env).status({...scope,sourceRef:`appstoreconnect:${bundleId.toLowerCase()}`});
    if(!state)return `${bundleId}: commerce notifications are not active in this Channel. Subscribe with the commerce feature to enable them.`;
    return `${bundleId}: commerce notifications enabled; ${state.observedAt ? `last observed ${state.observedAt}, ${state.products} products` : "initial baseline pending"}; `+
      `${state.pending} pending changes${state.retrying ? "; retry/work pending":""}. Next eligible observation ${state.nextPollAt ?? "next scheduled pass"}; backlog can delay it.`;
  } };
}
export const APP_STORE_CONNECT_COMMERCE_ACTIONS:Record<string,ConnectorAction>={
  commerce_status:{effect:"read",requires:[],parse:appOnly,async execute(context,input){
    if(!context.appleCommerce)throw new ProviderRequestError(503,"Commerce notification status is unavailable");
    return {summary:await context.appleCommerce.status(input.app!)};
  }},
};
