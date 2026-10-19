import assert from "node:assert/strict";
import { test } from "node:test";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import * as polling from "../src/connectors/gmail-poll-client.ts";
import { gmailIncomingChanges } from "../src/connectors/gmail-notification-api.ts";
import { parseMailboxes } from "../src/connectors/gmail-mailboxes.ts";
import { ProviderRequestError } from "../src/connectors/http.ts";
import { connectorMessageWakeTarget } from "../src/connector-message-delivery.ts";

const load=await compileCommonJsSourceModule(new URL("../src/connectors/gmail-notification-drain.ts",import.meta.url));
const env={CONNECTOR_GOOGLE_CLIENT_ID:"fixture-google",CONNECTOR_GOOGLE_CLIENT_SECRET:"fixture-secret",
  CONNECTOR_GMAIL_CLIENT_ID:"fixture-gmail",CONNECTOR_COMPOSIO_API_KEY:"fixture-composio"};
const counts={id:"INBOX",messagesTotal:10,messagesUnread:7,threadsTotal:8,threadsUnread:6};
async function drainer() {
  const job={id:"route-1",spaceId:"space-1",connectionId:"space-1:gmail",credentialVersion:1,generation:"generation",
    userId:"owner",channelId:"channel-1",mode:"poll",historyId:"100",pendingWake:false,
    nextSearchAt:new Date(Date.now()+900000).toISOString(),selection:{address:"me@example.com",account:"ca_owned",owner:"user:owner",
      refreshToken:"private-refresh",appIdentity:await polling.gmailPollIdentity(env),pollToken:{accessToken:"private-access",expiresAt:Date.now()+3600000}}};
  const calls={finish:[],stage:[],append:[],automation:[],cached:[],searched:0};
  let pending=[];
  const state={current:true};
  const repository={cleanup:async()=>{},claim:async()=>[job],current:async()=>state.current,polled:async()=>{},
    pending:async()=>pending,stage:async(_job,ids,historyId,pageToken)=>{calls.stage.push({ids,historyId,pageToken});pending=[...ids];},
    delivered:async(_job,id)=>{pending=pending.filter(item=>item!==id);},searched:async()=>{calls.searched++;},
    cachePollToken:async(_job,token)=>{calls.cached.push(token);},finish:async(_job,outcome)=>{calls.finish.push(outcome);}};
  const imports={"./credentials":{gmailRoutingRepository:()=>repository,connectorCredentialRepository:()=>({resolve:async()=>({
    version:1,connectionGeneration:"generation",values:{mailboxes:JSON.stringify([job.selection])}})})},
    "./gmail-mailboxes":{parseMailboxes},"./gmail-poll-client":polling,"./gmail-notification-api":{gmailIncomingChanges},
    "./gmail-watch-client":{},"./http":{ProviderRequestError},
    "../product-message-append":{dispatchProductMessageAppend:async(_env,_channel,message)=>{calls.append.push(message);return new Response();}},
    "../automation-triggers":{fireConnectorAutomationTriggers:async(_env,event)=>{calls.automation.push(event);}}};
  const {drainGmailNotifications}=load(name=>imports[name]);
  return {job,state,calls,run:()=>drainGmailNotifications(env)};
}

test("unchanged counts reuse the cached grant and avoid Composio until the independent check is due",async()=>{
  const idle=await drainer();
  const result=await fetched([{body:counts}],idle.run);
  assert.equal(result.calls.length,1);
  assert.equal(result.calls[0].url,"https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX");
  assert.deepEqual(idle.calls.finish,["done"]);assert.equal(idle.calls.searched,0);
  const due=await drainer();due.job.nextSearchAt=new Date(Date.now()-1).toISOString();
  await fetched([{body:counts},{body:{status:200,data:{historyId:"200",history:[{messagesAdded:[
    {message:{id:"abcdef1234567890",labelIds:["INBOX"]}}]}]}}}],due.run);
  assert.equal(due.calls.searched,1);assert.equal(due.calls.append.length,1);assert.equal(due.calls.automation.length,1);
  assert.deepEqual(due.calls.stage,[{ids:["abcdef1234567890"],historyId:"200",pageToken:undefined}]);
  assert.doesNotMatch(JSON.stringify(due.calls.append),/private-refresh|private-access|me@example/);
  // New mail reaches Automations through their trigger; the Channel notice wakes no live Agent.
  assert.equal(connectorMessageWakeTarget({from:{kind:"app"},metadata:due.calls.append[0].residual.appMetadata}),false);
});

test("pending changes, transient confirmation failure and lost authority retain the right outcome",async()=>{
  const changed=await drainer();changed.job.pendingWake=true;
  await fetched([{body:counts},{status:503,body:{}}],changed.run);
  assert.deepEqual(changed.calls.finish,["retry"]);assert.equal(changed.calls.stage.length,0);
  const stopped=await drainer();stopped.state.current=false;
  await fetched([],stopped.run);
  assert.deepEqual(stopped.calls.finish,["blocked"]);assert.equal(stopped.calls.append.length,0);
});

test("refreshes are encrypted by the repository; history expiry discloses a gap without replaying mail",async()=>{
  const expired=await drainer();expired.job.selection.pollToken.expiresAt=0;
  await fetched([{body:{access_token:"private-new-access",token_type:"Bearer",expires_in:3600}},
    {body:counts}],expired.run);
  assert.equal(expired.calls.cached[0].accessToken,"private-new-access");
  const gap=await drainer();gap.job.pendingWake=true;
  await fetched([{body:counts},{body:{status:404,data:{}}},
    {body:{status:200,data:{emailAddress:"me@example.com",historyId:"300"}}}],gap.run);
  assert.deepEqual(gap.calls.stage,[{ids:[],historyId:"300",pageToken:undefined}]);
  assert.match(gap.calls.append[0].body,/history expired/);
  assert.equal(connectorMessageWakeTarget({from:{kind:"app"},metadata:gap.calls.append[0].residual.appMetadata}),false);assert.equal(gap.calls.automation.length,0);
  assert.deepEqual(gap.calls.finish,["done"]);
});
