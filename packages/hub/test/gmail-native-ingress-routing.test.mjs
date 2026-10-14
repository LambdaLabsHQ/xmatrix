import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const target="https://xmatrix-hub.xmatrix.sh/api/connectors/gmail-watch/events";
const configured={GMAIL_WATCH_CLIENT_ID:"123456-fixture.apps.googleusercontent.com",GMAIL_WATCH_CLIENT_SECRET:"fixture-secret",
  GMAIL_WATCH_TOPIC:"projects/xmatrix-notify/topics/mail-events",GMAIL_WATCH_SUBSCRIPTION:"projects/xmatrix-notify/subscriptions/mail-push",
  GMAIL_WATCH_PUSH_EMAIL:"mail-push@xmatrix-notify.iam.gserviceaccount.com",GMAIL_WATCH_PUSH_AUDIENCE:target};

test("native Gmail ingress reaches its own authorization boundary before generic connector dispatch",async()=>{
  const context={waitUntil:()=>{}};
  const request=()=>new Request(target,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
  const unavailable=await worker.fetch(request(),{},context);
  assert.equal(unavailable.status,503);
  assert.deepEqual(await unavailable.json(),{error:"Gmail notifications are unavailable"});
  const unauthenticated=await worker.fetch(request(),configured,context);
  assert.equal(unauthenticated.status,401);
});
