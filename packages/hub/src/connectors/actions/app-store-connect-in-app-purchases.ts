import type { AppStoreConnectApi } from "../app-store-connect-api";
import { text } from "../event-format";
import type { ConnectorAction } from "../provider";
import { appAction, appCursorStatement } from "./app-store-connect";
import { prepareReadyProducts, productsStatement, submitReadyProducts } from "./app-store-connect-subscriptions";
import { quoteRetrievedText } from "./common";
import { cell } from "./google-report";

/*
 * One-time In-App Purchases: consumables, non-consumables and non-renewing
 * subscriptions (inAppPurchasesV2). Auto-renewable subscriptions are
 * app-store-connect-subscriptions.ts. As there, Apple reviews a purchase
 * through a version (API 4.4.1) that joins the app's draft review submission,
 * and `submit` then sends it with the app version; the older direct
 * inAppPurchaseSubmissions answers "no pending version" for a first purchase.
 */

async function inAppPurchases(api: AppStoreConnectApi, appId: string, complete: boolean, cursor?: string) {
  const path = `/v1/apps/${encodeURIComponent(appId)}/inAppPurchasesV2`;
  const query = { "fields[inAppPurchases]": "productId,name,inAppPurchaseType,state", limit: "200" };
  const result = complete
    ? { ...await api.listComplete(path, query, { incompleteMessage: "Apple returned more In-App Purchases than this action can inspect; no purchases were submitted" }), incomplete: false, cursor: undefined as string | undefined }
    : await api.listPreview(path, query, cursor ? { cursor } : undefined);
  return { incomplete: result.incomplete, cursor: result.cursor, rows: result.rows.map(row => ({ id: row.id, productId: text(row.attributes.productId), name: text(row.attributes.name),
    type: text(row.attributes.inAppPurchaseType), state: text(row.attributes.state) || "UNKNOWN" })) };
}

const purchaseSubmitOptions = (api: AppStoreConnectApi, appId: string) => ({
  singular: "In-App Purchase",
  plural: "In-App Purchases",
  listAction: "in_app_purchases",
  load: async () => (await inAppPurchases(api, appId, true)).rows,
  draftItems: (chosen: Awaited<ReturnType<typeof inAppPurchases>>["rows"]) =>
    chosen.map(row => ({ kind: "inAppPurchases" as const, id: row.id })),
});

export const APP_STORE_CONNECT_IN_APP_PURCHASE_ACTIONS: Record<string, ConnectorAction> = {
  in_app_purchases: appAction("read", appCursorStatement, async ({ api, app, input }) => {
    const { rows, incomplete, cursor } = await inAppPurchases(api, app.id, false, input.cursor);
    const lines = rows.map(row => [cell(row.productId), cell(row.name), cell(row.type), cell(row.state)].join("\t"));
    return `One-time In-App Purchases of ${input.app}:\n` + quoteRetrievedText(lines.length
      ? ["product id\tname\ttype\tstate", ...lines].join("\n") : "(none)") +
      (incomplete ? `\nApple returned more purchases; this list is incomplete.${cursor ? ` Continue with cursor:${cursor}` : ""}` : "");
  }),
  submit_in_app_purchases: appAction("write", productsStatement,
    async ({ api, app, input }) => submitReadyProducts(api, app.id, input, purchaseSubmitOptions(api, app.id)),
    async ({ api, app, input }) => prepareReadyProducts(api, app.id, input, purchaseSubmitOptions(api, app.id))),
};
