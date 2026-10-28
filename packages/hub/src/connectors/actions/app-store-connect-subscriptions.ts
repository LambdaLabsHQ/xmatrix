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
/* A version still being prepared joins the draft as it is; anything else means a new one. */
const PENDING: ReadonlySet<string> = new Set(["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"]);

/**
 * The pending version of a subscription or group, created when there is none. A group Apple already
 * approved has nothing to review unless it was changed, which leaves a pending version of its own.
 */
async function pendingVersion(api: AppStoreConnectApi, kind: "subscriptions" | "subscriptionGroups", id: string): Promise<AppleResource | undefined> {
  const versionType = kind === "subscriptions" ? "subscriptionVersions" : "subscriptionGroupVersions";
  const { rows } = await api.list(`/v1/${kind}/${encodeURIComponent(id)}/versions`, { [`fields[${versionType}]`]: "state", limit: "50" }, 1);
  const pending = rows.find(row => PENDING.has(text(row.attributes.state)));
  if (pending) return pending;
  if (kind === "subscriptionGroups" && rows.some(row => text(row.attributes.state) === "APPROVED")) return undefined;
  const created = appleResource((await api.request(`/v1/${versionType}`, { method: "POST", data: { type: versionType,
    relationships: { [kind === "subscriptions" ? "subscription" : "subscriptionGroup"]: relation(kind, id) } } })).data);
  if (!created) throw new ProviderRequestError(502, "App Store Connect did not return the new version");
  return created;
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
  submit_subscriptions: appAction("write", statement => {
    const app = bundleId(statement.target), named = statement.text.trim().split(/\s+/u).filter(Boolean);
    return app && named.length <= MAX_NAMED && named.every(id => PRODUCT_ID.test(id)) ? { app, products: named.join(" ") }
      : "name an app and, optionally, the product ids to submit (default: every one ready to submit): <com.example.app> [<product id> …]";
  }, async ({ api, app, input }) => {
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
    const draft = await draftSubmission(api, app.id);
    const items = (await api.list(`/v1/reviewSubmissions/${encodeURIComponent(draft.id)}/items`,
      { "fields[reviewSubmissionItems]": "subscriptionVersion,subscriptionGroupVersion", limit: "200" }, 1)).rows;
    const present = new Set(items.flatMap(item => [relatedId(item, "subscriptionVersion"), relatedId(item, "subscriptionGroupVersion")])
      .filter((id): id is string => Boolean(id)));
    const versions = [
      ...await Promise.all([...new Set(chosen.map(row => row.groupId))].map(async id =>
        ({ key: "subscriptionGroupVersion", type: "subscriptionGroupVersions", version: await pendingVersion(api, "subscriptionGroups", id) }))),
      ...await Promise.all(chosen.map(async row =>
        ({ key: "subscriptionVersion", type: "subscriptionVersions", version: await pendingVersion(api, "subscriptions", row.id) }))),
    ];
    for (const { key, type, version } of versions.flatMap(entry => entry.version && !present.has(entry.version.id) ? [{ ...entry, version: entry.version }] : [])) {
      await api.request("/v1/reviewSubmissionItems", { method: "POST", data: { type: "reviewSubmissionItems", relationships: {
        reviewSubmission: relation("reviewSubmissions", draft.id), [key]: relation(type, version.id) } } });
    }
    return `Added ${chosen.map(row => row.productId).join(", ")} of ${input.app} to the draft review submission. ` +
      "Run submit for the app version to send them to App Review with it.";
  }),
};
