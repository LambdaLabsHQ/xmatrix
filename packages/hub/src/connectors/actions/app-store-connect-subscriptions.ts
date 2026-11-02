import { appleResource, relatedId, relation, type AppleResource, type AppStoreConnectApi } from "../app-store-connect-api";
import { text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { appAction, bundleId, openSubmissions } from "./app-store-connect";
import { quoteRetrievedText } from "./common";
import { cell } from "./google-report";

/*
 * Auto-renewable subscriptions and their App Review. Apple reviews a
 * subscription through a subscription version (API 4.4.1): each one, and its
 * group's, joins the app's draft review submission as an item, and `submit`
 * then sends the draft with the app version. An app's first subscriptions can
 * only be reviewed that way.
 */

const PRODUCT_ID = /^[A-Za-z0-9._-]{1,100}$/u;
const MAX_NAMED = 20;
/* The state Apple must report before a subscription can be submitted. */
const READY = "READY_TO_SUBMIT";
/* Only a version Apple has finished with needs a new one; any other is still in flight and is reused. */
const FINISHED: ReadonlySet<string> = new Set(["APPROVED", "ACCEPTED", "REPLACED_WITH_NEW_VERSION"]);
/* Apple names the version in flight when it refuses another, which the version list may not show. */
const IN_FLIGHT = /already an inflight version with id '([A-Za-z0-9-]{1,64})'/u;

/**
 * What Apple reviews through a version (API 4.4.1): where its versions are
 * listed, the version's type, how a new one names its parent, and the review
 * submission item that carries it.
 */
const VERSIONED = {
  subscriptions: { list: "/v1/subscriptions", versionType: "subscriptionVersions", parent: "subscription", item: "subscriptionVersion" },
  subscriptionGroups: { list: "/v1/subscriptionGroups", versionType: "subscriptionGroupVersions", parent: "subscriptionGroup", item: "subscriptionGroupVersion" },
  inAppPurchases: { list: "/v2/inAppPurchases", versionType: "inAppPurchaseVersions", parent: "inAppPurchase", item: "inAppPurchaseVersion" },
} as const;
export type VersionedKind = keyof typeof VERSIONED;

/**
 * The version of a product still in flight, created when there is none. A group Apple
 * already approved has nothing to review unless it was changed, which leaves a version of its own.
 */
async function pendingVersion(api: AppStoreConnectApi, kind: VersionedKind, id: string): Promise<AppleResource | undefined> {
  const { list, versionType, parent } = VERSIONED[kind];
  const { rows } = await api.list(`${list}/${encodeURIComponent(id)}/versions`, { [`fields[${versionType}]`]: "state", limit: "50" }, 1);
  const pending = rows.find(row => !FINISHED.has(text(row.attributes.state)));
  if (pending) return pending;
  if (kind === "subscriptionGroups" && rows.some(row => text(row.attributes.state) === "APPROVED")) return undefined;
  const created = await api.request(`/v1/${versionType}`, { method: "POST", data: { type: versionType,
    relationships: { [parent]: relation(kind, id) } } })
    .then(response => appleResource(response.data), (error: unknown) => {
      const inFlight = error instanceof ProviderRequestError && error.status === 409 ? IN_FLIGHT.exec(error.message)?.[1] : undefined;
      if (!inFlight) throw error;
      return { type: versionType, id: inFlight, attributes: {} } as AppleResource;
    });
  if (!created) throw new ProviderRequestError(502, "App Store Connect did not return the new version");
  return created;
}

/**
 * Puts each product's pending version in the app's draft review submission once; the next
 * `submit` of an app version sends them to App Review with it.
 */
export async function addVersionsToDraft(api: AppStoreConnectApi, appId: string, products: ReadonlyArray<{ kind: VersionedKind; id: string }>) {
  const draft = await draftSubmission(api, appId);
  const keys = Object.values(VERSIONED).map(entry => entry.item);
  const items = (await api.list(`/v1/reviewSubmissions/${encodeURIComponent(draft.id)}/items`,
    { "fields[reviewSubmissionItems]": keys.join(","), limit: "200" }, 1)).rows;
  const present = new Set(items.flatMap(item => keys.map(key => relatedId(item, key))).filter((id): id is string => Boolean(id)));
  const versions = await Promise.all(products.map(async ({ kind, id }) => ({ ...VERSIONED[kind], version: await pendingVersion(api, kind, id) })));
  for (const { item, versionType, version } of versions) {
    if (!version || present.has(version.id)) continue;
    await api.request("/v1/reviewSubmissionItems", { method: "POST", data: { type: "reviewSubmissionItems", relationships: {
      reviewSubmission: relation("reviewSubmissions", draft.id), [item]: relation(versionType, version.id) } } });
  }
}

/** The app's draft review submission on iOS, opened when there is none; one already sent is not changed. */
async function draftSubmission(api: AppStoreConnectApi, appId: string): Promise<AppleResource> {
  const open = await openSubmissions(api, appId, "IOS");
  if (open.length > 1) throw new ProviderRequestError(409, "More than one review submission is open; settle them in App Store Connect first");
  const state = text(open[0]?.attributes.state);
  if (open[0] && state !== "READY_FOR_REVIEW") throw new ProviderRequestError(409, `The open review submission is ${state}; wait for it or cancel it first`);
  const draft = open[0] ?? appleResource((await api.request("/v1/reviewSubmissions", { method: "POST", data: { type: "reviewSubmissions",
    attributes: { platform: "IOS" }, relationships: { app: relation("apps", appId) } } })).data);
  if (!draft) throw new ProviderRequestError(502, "App Store Connect did not return the review submission");
  return draft;
}

/** An app and, optionally, the product ids to submit: what each submit_* action takes. */
export function productsStatement(statement: { target: string; text: string }): Record<string, string> | string {
  const app = bundleId(statement.target), named = statement.text.trim().split(/\s+/u).filter(Boolean);
  return app && named.length <= MAX_NAMED && named.every(id => PRODUCT_ID.test(id)) ? { app, products: named.join(" ") }
    : "name an app and, optionally, the product ids to submit (default: every one ready to submit): <com.example.app> [<product id> …]";
}

async function subscriptions(api: AppStoreConnectApi, appId: string) {
  const groups = (await api.list(`/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups`,
    { "fields[subscriptionGroups]": "referenceName", limit: "50" }, 1)).rows;
  const lists = await Promise.all(groups.map(group => api.list(`/v1/subscriptionGroups/${encodeURIComponent(group.id)}/subscriptions`,
    { "fields[subscriptions]": "productId,name,state,groupLevel,subscriptionPeriod", limit: "200" }, 1)));
  return groups.flatMap((group, index) => lists[index]!.rows.map(row => ({ id: row.id, groupId: group.id, group: text(group.attributes.referenceName),
    productId: text(row.attributes.productId), name: text(row.attributes.name), state: text(row.attributes.state) || "UNKNOWN",
    level: text(row.attributes.groupLevel), period: text(row.attributes.subscriptionPeriod) })));
}

export const APP_STORE_CONNECT_SUBSCRIPTION_ACTIONS: Record<string, ConnectorAction> = {
  subscriptions: appAction("read",
    statement => bundleId(statement.target) && !statement.text.trim() ? { app: statement.target } : "name an app by its bundle ID: <com.example.app>",
    async ({ api, app, input }) => {
      const rows = await subscriptions(api, app.id);
      const lines = rows.map(row => [cell(row.group), cell(row.productId), cell(row.name), cell(row.period), cell(row.level), cell(row.state)].join("\t"));
      return `Subscriptions of ${input.app}:\n` + quoteRetrievedText(lines.length
        ? ["group\tproduct id\tname\tperiod\tlevel\tstate", ...lines].join("\n") : "(none)");
    }),
  submit_subscriptions: appAction("write", productsStatement, async ({ api, app, input }) => {
    const rows = await subscriptions(api, app.id);
    const named = input.products ? input.products.split(" ") : [];
    const missing = named.filter(id => !rows.some(row => row.productId === id));
    if (missing.length) throw new ProviderRequestError(404, `${input.app} has no subscription ${missing.join(", ")}; subscriptions lists them`);
    const chosen = named.length ? rows.filter(row => named.includes(row.productId)) : rows.filter(row => row.state === READY);
    const blocked = chosen.filter(row => row.state !== READY);
    if (blocked.length) {
      throw new ProviderRequestError(409, `Only ${READY} subscriptions can be submitted; ` +
        blocked.map(row => `${row.productId} is ${row.state}`).join(", "));
    }
    if (!chosen.length) return `No subscription of ${input.app} is ${READY}; nothing was submitted.`;
    await addVersionsToDraft(api, app.id, [...[...new Set(chosen.map(row => row.groupId))].map(id => ({ kind: "subscriptionGroups" as const, id })),
      ...chosen.map(row => ({ kind: "subscriptions" as const, id: row.id }))]);
    return `Added ${chosen.map(row => row.productId).join(", ")} of ${input.app} to the draft review submission. ` +
      "Run submit for the app version to send them to App Review with it.";
  }),
};
