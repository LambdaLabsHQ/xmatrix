import assert from "node:assert/strict";
import { test } from "node:test";
import { readAppleCommerceStates } from "../src/connectors/app-store-connect-commerce.ts";
import { appStoreConnect } from "../src/connectors/app-store-connect-api.ts";
import { credentials, withApple } from "./support/app-store-connect-double.mjs";

const groups = "GET /v1/apps/app/subscriptionGroups", subscriptions = "GET /v1/subscriptionGroups/g1/subscriptions", purchases = "GET /v1/apps/app/inAppPurchasesV2";
const routes = { [groups]: { data: [{ type:"subscriptionGroups",id:"g1" }] },
  [subscriptions]: { data: [{ type:"subscriptions",id:"s1",attributes:{state:"IN_REVIEW"} }] },
  [purchases]: { data: [{ type:"inAppPurchases",id:"i1",attributes:{state:"APPROVED"} }] } };

test("commerce polling reads only app-scoped public product states and rejects incomplete or escaped snapshots", async () => {
  const read = () => readAppleCommerceStates(appStoreConnect(credentials),"app");
  const actual = await withApple(routes,read);
  assert.deepEqual(actual.value,[{kind:"subscription",id:"s1",state:"IN_REVIEW"},{kind:"inAppPurchase",id:"i1",state:"APPROVED"}]);
  assert.ok(actual.calls.every(call=>call.origin==="https://api.appstoreconnect.apple.com" && call.cookie===null));
  for (const bad of [{data:[{type:"subscriptions",id:"s1"}]},
    {data:routes[subscriptions].data,links:{next:"https://foreign.invalid/private"}},
    {data:[],links:{next:"https://api.appstoreconnect.apple.com/v1/subscriptionGroups/other/subscriptions?cursor=2"}},
    {data:[],links:{next:"https://api.appstoreconnect.apple.com/v1/subscriptionGroups/g1/subscriptions?fields[subscriptions]=state&limit=200&cursor=same"}}]) {
    const refused=await withApple({...routes,[subscriptions]:bad},()=>read().catch(error=>error));
    assert.ok(refused.value instanceof Error);
    assert.ok(refused.calls.every(call=>call.origin==="https://api.appstoreconnect.apple.com"));
  }
});
