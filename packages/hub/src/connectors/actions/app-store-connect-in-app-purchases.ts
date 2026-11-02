import { relation, type AppStoreConnectApi } from "../app-store-connect-api";
import { text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { appAction, bundleId } from "./app-store-connect";
import { productsStatement } from "./app-store-connect-subscriptions";
import { quoteRetrievedText } from "./common";
import { cell } from "./google-report";

/*
 * One-time In-App Purchases: consumables, non-consumables and non-renewing
 * subscriptions (API 4.4.1, inAppPurchasesV2). Auto-renewable subscriptions
 * are app-store-connect-subscriptions.ts. Apple reviews a purchase once it is
 * submitted; an app's first purchases are reviewed with its next app version,
 * so `submit` for that version follows.
 */

/* The state Apple must report before a purchase can be submitted. */
const READY = "READY_TO_SUBMIT";

async function inAppPurchases(api: AppStoreConnectApi, appId: string) {
  const { rows } = await api.list(`/v1/apps/${encodeURIComponent(appId)}/inAppPurchasesV2`,
    { "fields[inAppPurchases]": "productId,name,inAppPurchaseType,state", limit: "200" }, 1);
  return rows.map(row => ({ id: row.id, productId: text(row.attributes.productId), name: text(row.attributes.name),
    type: text(row.attributes.inAppPurchaseType), state: text(row.attributes.state) || "UNKNOWN" }));
}

const appOnly = (statement: { target: string; text: string }) =>
  bundleId(statement.target) && !statement.text.trim() ? { app: statement.target } : "name an app by its bundle ID: <com.example.app>";

export const APP_STORE_CONNECT_IN_APP_PURCHASE_ACTIONS: Record<string, ConnectorAction> = {
  in_app_purchases: appAction("read", appOnly, async ({ api, app, input }) => {
    const rows = await inAppPurchases(api, app.id);
    const lines = rows.map(row => [cell(row.productId), cell(row.name), cell(row.type), cell(row.state)].join("\t"));
    return `One-time In-App Purchases of ${input.app}:\n` + quoteRetrievedText(lines.length
      ? ["product id\tname\ttype\tstate", ...lines].join("\n") : "(none)");
  }),
  submit_in_app_purchases: appAction("write", productsStatement, async ({ api, app, input }) => {
    const rows = await inAppPurchases(api, app.id);
    const named = input.products ? input.products.split(" ") : [];
    const missing = named.filter(id => !rows.some(row => row.productId === id));
    if (missing.length) throw new ProviderRequestError(404, `${input.app} has no In-App Purchase ${missing.join(", ")}; in_app_purchases lists them`);
    const chosen = named.length ? rows.filter(row => named.includes(row.productId)) : rows.filter(row => row.state === READY);
    const blocked = chosen.filter(row => row.state !== READY);
    if (blocked.length) {
      throw new ProviderRequestError(409, `Only ${READY} In-App Purchases can be submitted; ` +
        blocked.map(row => `${row.productId} is ${row.state}`).join(", "));
    }
    if (!chosen.length) return `No In-App Purchase of ${input.app} is ${READY}; nothing was submitted.`;
    for (const row of chosen) {
      await api.request("/v1/inAppPurchaseSubmissions", { method: "POST", data: { type: "inAppPurchaseSubmissions",
        relationships: { inAppPurchaseV2: relation("inAppPurchases", row.id) } } });
    }
    return `Submitted ${chosen.map(row => row.productId).join(", ")} of ${input.app} for review. ` +
      "An app's first In-App Purchases are reviewed with its next app version: run submit for that version.";
  }),
};
