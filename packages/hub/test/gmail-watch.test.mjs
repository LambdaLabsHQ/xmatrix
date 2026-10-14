import assert from "node:assert/strict";
import { test } from "node:test";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import { gmailWatchToken,renewGmailWatch,GMAIL_WATCH_SCOPE } from "../src/connectors/gmail-watch-client.ts";
import { gmailIncomingChanges } from "../src/connectors/gmail-notification-api.ts";
import { gmailPushPayload } from "../src/connectors/gmail-watch-ingress.ts";
import { parseGmailWatchConfig } from "@xmatrix/protocol";

const env={GMAIL_WATCH_CLIENT_ID:"123456-abcdef.apps.googleusercontent.com",GMAIL_WATCH_CLIENT_SECRET:"fixture-secret",
  GMAIL_WATCH_TOPIC:"projects/xmatrix-notify/topics/mail-events",GMAIL_WATCH_SUBSCRIPTION:"projects/xmatrix-notify/subscriptions/mail-push",
  GMAIL_WATCH_PUSH_EMAIL:"mail-push@xmatrix-notify.iam.gserviceaccount.com",GMAIL_WATCH_PUSH_AUDIENCE:"https://hub.example.com/api/connectors/gmail-watch/events"};
const token={access_token:"fixture-access",refresh_token:"fixture-refresh",scope:GMAIL_WATCH_SCOPE,token_type:"Bearer",expires_in:3600};

test("native notification configuration is atomic, project-bound and never accepts arbitrary callback hosts",()=>{
  assert.equal(parseGmailWatchConfig({}),undefined);
  assert.equal(parseGmailWatchConfig(env).subscription,env.GMAIL_WATCH_SUBSCRIPTION);
  for(const key of Object.keys(env))assert.throws(()=>parseGmailWatchConfig({...env,[key]:""}));
  for(const audience of ["http://hub.example.com/api/connectors/gmail-watch/events","https://127.0.0.1/api/connectors/gmail-watch/events",
    "https://hub.example.com/other","https://hub.example.com/api/connectors/gmail-watch/events?key=secret"])
    assert.throws(()=>parseGmailWatchConfig({...env,GMAIL_WATCH_PUSH_AUDIENCE:audience}));
  assert.throws(()=>parseGmailWatchConfig({...env,GMAIL_WATCH_SUBSCRIPTION:"projects/another-project/subscriptions/mail-push"}));
});
test("notification OAuth refuses broad, duplicate and missing offline scopes",async()=>{
  for(const changes of [{scope:"https://mail.google.com/"},{scope:`${GMAIL_WATCH_SCOPE} ${GMAIL_WATCH_SCOPE}`},{refresh_token:undefined},{scope:undefined}]) {
    await fetched([{body:{...token,...changes}}],()=>assert.rejects(gmailWatchToken(env,{grant_type:"authorization_code",code:"fixture-code"},true),/notification-only/));
  }
  const result=await fetched([{body:token}],()=>gmailWatchToken(env,{grant_type:"authorization_code",code:"fixture-code"},true));
  assert.equal(result.result.refreshToken,"fixture-refresh");
  assert.equal(result.calls[0].url,"https://oauth2.googleapis.com/token");
});
test("watch requests inbox-only signals with expiry; history paging preserves the start cursor",async()=>{
  const watched=await fetched([{body:{historyId:"100",expiration:String(Date.now()+86400000)}}],()=>renewGmailWatch(env,"fixture-access"));
  assert.deepEqual(watched.calls[0].body,{topicName:env.GMAIL_WATCH_TOPIC,labelIds:["INBOX"],labelFilterBehavior:"include"});
  const page={historyId:"200",nextPageToken:"next-page",history:[{messagesAdded:[
    {message:{id:"abcdef1234567890",labelIds:["INBOX"]}},
    {message:{id:"abcdef1234567891",labelIds:["INBOX","SENT"]}},
    {message:{id:"abcdef1234567890",labelIds:["INBOX"]}},
    {message:{id:"abcdef1234567892",labelIds:["SPAM"]}},
  ]}]};
  const result=await fetched([{body:page}],()=>gmailIncomingChanges("fixture-access","100"));
  assert.deepEqual(result.result,{messages:["abcdef1234567890"],historyId:"100",pageToken:"next-page"});
  assert.equal(new URL(result.calls[0].url).pathname,"/gmail/v1/users/me/history");
  assert.equal(new URL(result.calls[0].url).searchParams.get("historyTypes"),"messageAdded");
  const last=await fetched([{body:{historyId:"200"}}],()=>gmailIncomingChanges("fixture-access","100","next-page"));
  assert.equal(last.result.historyId,"200");
  assert.equal(last.result.pageToken,undefined);
});
test("Pub/Sub envelope only accepts the configured subscription and bounded mailbox change identities",()=>{
  const message={data:Buffer.from(JSON.stringify({emailAddress:"ME@example.com",historyId:"100"})).toString("base64url"),messageId:"123"};
  assert.deepEqual(gmailPushPayload({subscription:env.GMAIL_WATCH_SUBSCRIPTION,message},env.GMAIL_WATCH_SUBSCRIPTION),
    {address:"me@example.com",historyId:"100"});
  for(const envelope of [{subscription:"other",message},{subscription:env.GMAIL_WATCH_SUBSCRIPTION,message:{...message,data:"bad"}},
    {subscription:env.GMAIL_WATCH_SUBSCRIPTION,message:{...message,messageId:"bad"}}])
    assert.throws(()=>gmailPushPayload(envelope,env.GMAIL_WATCH_SUBSCRIPTION));
});

test("push ingress verifies Google signatures, issuer, audience and the exact verified service identity before accepting work",async()=>{
  const {generateKeyPair,exportJWK,SignJWT}=await import("jose");
  const {handleGmailWatchPush}=await import("../src/connectors/gmail-watch-ingress.ts");
  const keys=await generateKeyPair("RS256");
  const jwk={...await exportJWK(keys.publicKey),kid:"gmail-security-fixture",alg:"RS256",use:"sig"};
  const fetchOriginal=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({keys:[jwk]});
  const sign=(changes={},privateKey=keys.privateKey)=>new SignJWT({email:env.GMAIL_WATCH_PUSH_EMAIL,email_verified:true,...changes})
    .setProtectedHeader({alg:"RS256",kid:jwk.kid}).setIssuer("https://accounts.google.com")
    .setAudience(env.GMAIL_WATCH_PUSH_AUDIENCE).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const receive=async jwt=>handleGmailWatchPush(env,new Request(env.GMAIL_WATCH_PUSH_AUDIENCE,{method:"POST",
    headers:{authorization:`Bearer ${jwt}`},body:"{}"}),()=>assert.fail("Unauthenticated work must never be queued"));
  try {
    // Valid cryptographic identity reaches envelope validation, without database access.
    assert.equal((await receive(await sign())).status,400);
    for(const claims of [{email:"other@xmatrix-notify.iam.gserviceaccount.com"},{email_verified:false}])
      assert.equal((await receive(await sign(claims))).status,401);
    const tokenWith=async(issuer,audience)=>new SignJWT({email:env.GMAIL_WATCH_PUSH_EMAIL,email_verified:true})
      .setProtectedHeader({alg:"RS256",kid:jwk.kid}).setIssuer(issuer).setAudience(audience)
      .setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    assert.equal((await receive(await tokenWith("https://attacker.example",env.GMAIL_WATCH_PUSH_AUDIENCE))).status,401);
    assert.equal((await receive(await tokenWith("https://accounts.google.com","https://other.example"))).status,401);
    const other=await generateKeyPair("RS256");
    assert.equal((await receive(await sign({},other.privateKey))).status,401);
  } finally {globalThis.fetch=fetchOriginal;}
});
