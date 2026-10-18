import assert from "node:assert/strict";
import { test } from "node:test";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import { gmailPollToken,verifyGmailPollMailbox,gmailInboxFingerprint,gmailComposioBaseline,
  gmailComposioNotificationGet,GMAIL_POLL_SCOPES } from "../src/connectors/gmail-poll-client.ts";
import { gmailIncomingChanges } from "../src/connectors/gmail-notification-api.ts";
import { gmailPollCallback,gmailPollState } from "../src/connectors/gmail-poll-oauth.ts";
import { signGitHubAppState } from "../src/index-shared.ts";

const env={APP_URL:"https://xmatrix.sh",CONNECTOR_GOOGLE_CLIENT_ID:"google-fixture",CONNECTOR_GOOGLE_CLIENT_SECRET:"google-secret",
  CONNECTOR_GMAIL_CLIENT_ID:"gmail-fixture",CONNECTOR_COMPOSIO_API_KEY:"composio-secret"};
const token={access_token:"private-access",refresh_token:"private-refresh",token_type:"Bearer",expires_in:3600,
  scope:GMAIL_POLL_SCOPES.join(" ")};

test("polling refuses broad, duplicate, incomplete or non-expiring Google grants",async()=>{
  for(const changes of [{scope:"https://mail.google.com/"},{scope:`${token.scope} ${GMAIL_POLL_SCOPES[0]}`},
    {scope:GMAIL_POLL_SCOPES[0]},{refresh_token:undefined},{expires_in:0},{scope:undefined}])
    await fetched([{body:{...token,...changes}}],()=>assert.rejects(gmailPollToken(env,{code:"code"},true),/labels-only/));
  const accepted=await fetched([{body:token}],()=>gmailPollToken(env,{code:"code"},true));
  assert.equal(accepted.result.refreshToken,"private-refresh");
  assert.equal(accepted.calls[0].body.client_id,env.CONNECTOR_GOOGLE_CLIENT_ID);
  await fetched([{status:400,body:{error:"invalid_grant"}}],()=>
    assert.rejects(gmailPollToken(env,{grant_type:"refresh_token"},false),error=>error.status===401));
});

test("labels grant is bound to the selected verified mailbox without requiring Gmail profile access",async()=>{
  const valid=await fetched([{body:{email:"Me@Example.com",email_verified:true}}],()=>verifyGmailPollMailbox("private-access","me@example.com"));
  assert.equal(valid.calls[0].url,"https://openidconnect.googleapis.com/v1/userinfo");
  for(const body of [{email:"other@example.com",email_verified:true},{email:"me@example.com",email_verified:false}])
    await fetched([{body}],()=>assert.rejects(verifyGmailPollMailbox("private-access","me@example.com"),error=>error.status===403));
});

test("all four inbox counts participate in the hint; malformed or foreign label counts fail closed",async()=>{
  const counts={id:"INBOX",messagesTotal:10,messagesUnread:7,threadsTotal:8,threadsUnread:6};
  const checked=await fetched([{body:counts}],()=>gmailInboxFingerprint("private-access"));
  assert.equal(checked.result,"10,7,8,6");
  assert.equal(new URL(checked.calls[0].url).pathname,"/gmail/v1/users/me/labels/INBOX");
  for(const body of [{...counts,id:"SENT"},{...counts,messagesTotal:-1},{...counts,threadsUnread:undefined}])
    await fetched([{body}],()=>assert.rejects(gmailInboxFingerprint("private-access")));
});

test("confirmation uses only the selected Composio account, preserves paging, and ignores old mail label moves",async()=>{
  const result=await fetched([{body:{status:200,data:{historyId:"200",nextPageToken:"next",history:[
    {labelsAdded:[{message:{id:"aaaaaaaaaaaaaaaa",labelIds:["INBOX"]}}]},
    {messagesAdded:[{message:{id:"bbbbbbbbbbbbbbbb",labelIds:["INBOX"]}},
      {message:{id:"cccccccccccccccc",labelIds:["INBOX","SENT"]}}]}]}}}],()=>
    gmailIncomingChanges("","100",undefined,query=>gmailComposioNotificationGet(env,"ca_owned","space-1","/history",query)));
  assert.deepEqual(result.result,{messages:["bbbbbbbbbbbbbbbb"],historyId:"100",pageToken:"next"});
  assert.equal(result.calls[0].body.connected_account_id,"ca_owned");
  assert.equal(result.calls[0].body.endpoint,"https://gmail.googleapis.com/gmail/v1/users/me/history");
  assert.ok(result.calls[0].body.parameters.some(p=>p.name==="startHistoryId" && p.value==="100"));
  await fetched([{body:{status:200,data:{emailAddress:"other@example.com",historyId:"100"}}}],()=>
    assert.rejects(gmailComposioBaseline(env,"ca_owned","space-1","me@example.com")));
});

test("shared Google callback routes only signed notification state and never exchanges codes before Human completion",async()=>{
  const {gmailPollIdentity}=await import("../src/connectors/gmail-poll-client.ts");
  const claims={kind:"gmail-poll",id:"route-1",nonce:"nonce",userId:"owner",spaceId:"space-1",
    redirectUri:"https://xmatrix-hub.xmatrix.sh/api/connectors/oauth/callback",appIdentity:await gmailPollIdentity(env),expiresAt:Date.now()+60000};
  const state=await signGitHubAppState(claims,env.CONNECTOR_GOOGLE_CLIENT_SECRET);
  const response=await fetched([],()=>gmailPollCallback(env,new Request(`${claims.redirectUri}?state=${encodeURIComponent(state)}&code=private-code`)));
  const target=new URL(response.result.headers.get("location"));
  assert.equal(target.searchParams.get("connector"),"gmail");
  assert.equal(target.searchParams.get("gmailWatchCode"),"private-code");
  assert.equal(response.calls.length,0);
  assert.equal(await gmailPollState(env,`${state}tampered`),undefined);
  const other=await signGitHubAppState({...claims,kind:"ordinary-connect"},env.CONNECTOR_GOOGLE_CLIENT_SECRET);
  assert.equal(await gmailPollCallback(env,new Request(`${claims.redirectUri}?state=${encodeURIComponent(other)}`)),undefined);
});
