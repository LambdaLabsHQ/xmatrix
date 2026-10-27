import { appleResource, relation, type AppStoreConnectApi } from "../app-store-connect-api";
import { text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { appAction, bundleId } from "./app-store-connect";
import { quoteRetrievedText } from "./common";
import { cell } from "./google-report";

/*
 * Auto-renewable subscriptions and their App Review. Apple reviews an app's
 * first subscriptions together with its next version submission: a
 * subscription submission marks them to go along, and `submit` then sends the
 * version. Later subscriptions are reviewed on their own.
 */

const PRODUCT_ID = /^[A-Za-z0-9._-]{1,100}$/u;
const MAX_NAMED = 20;
/* The state Apple must report before a subscription can be submitted. */
const READY = "READY_TO_SUBMIT";

async function subscriptions(api: AppStoreConnectApi, appId: string) {
  const groups = (await api.list(`/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups`,
    { "fields[subscriptionGroups]": "referenceName", limit: "50" }, 1)).rows;
  const lists = await Promise.all(groups.map(group => api.list(`/v1/subscriptionGroups/${encodeURIComponent(group.id)}/subscriptions`,
    { "fields[subscriptions]": "productId,name,state,groupLevel,subscriptionPeriod", limit: "200" }, 1)));
  return groups.flatMap((group, index) => lists[index]!.rows.map(row => ({ id: row.id, group: text(group.attributes.referenceName),
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
    for (const row of chosen) {
      const sent = appleResource((await api.request("/v1/subscriptionSubmissions", { method: "POST", data: { type: "subscriptionSubmissions",
        relationships: { subscription: relation("subscriptions", row.id) } } })).data);
      if (!sent) throw new ProviderRequestError(502, `App Store Connect did not accept the submission of ${row.productId}`);
    }
    return `Submitted ${chosen.map(row => row.productId).join(", ")} of ${input.app} for review. ` +
      "An app's first subscriptions are reviewed with its next version: submit that version to send them.";
  }),
};
