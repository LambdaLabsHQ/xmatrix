import assert from "node:assert/strict";
import { test } from "node:test";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import * as polling from "../src/connectors/gmail-poll-client.ts";
import { gmailIncomingChanges } from "../src/connectors/gmail-notification-api.ts";
import { parseMailboxes } from "../src/connectors/gmail-mailboxes.ts";
import { ProviderRequestError } from "../src/connectors/http.ts";

const load=await compileCommonJsSourceModule(new URL("../src/connectors/gmail-notification-drain.ts",import.meta.url));
const env={CONNECTOR_GOOGLE_CLIENT_ID:"fixture-google",CONNECTOR_GOOGLE_CLIENT_SECRET:"fixture-secret",
  CONNECTOR_GMAIL_CLIENT_ID:"fixture-gmail",CONNECTOR_COMPOSIO_API_KEY:"fixture-composio"};
const counts={id:"INBOX",messagesTotal:10,messagesUnread:7,threadsTotal:8,threadsUnread:6};
async function drainer() {
  const job={id:"route-1",spaceId:"space-1",connectionId:"space-1:gmail",credentialVersion:1,generation:"generation",
    userId:"owner",mode:"poll",historyId:"100",pendingWake:false,
    nextSearchAt:new Date(Date.now()+900000).toISOString(),selection:{address:"me@example.com",account:"ca_owned",owner:"user:owner",
      refreshToken:"private-refresh",appIdentity:await polling.gmailPollIdentity(env),pollToken:{accessToken:"private-access",expiresAt:Date.now()+3600000}}};
  const calls={finish:[],stage:[],append:[],automation:[],cached:[],searched:0,read:[]};
  const recent={count:0};
  // The owner's subscription to this mailbox; tests add others.
  const routes={"gmail:me@example.com":[{channelId:"channel-1",authorityRootUserId:"owner",features:["message.received"]}],"gmail:*":[]};
  let pending=[];
  const state={current:true};
  const repository={cleanup:async()=>{},claim:async()=>[job],current:async()=>state.current,polled:async()=>{},
    pending:async()=>pending,stage:async(_job,ids,historyId,pageToken)=>{calls.stage.push({ids,historyId,pageToken});pending=[...ids];},
    delivered:async(_job,id)=>{pending=pending.filter(item=>item!==id);},searched:async()=>{calls.searched++;},
    deliveredLastHour:async(_job,limit)=>Math.min(recent.count,limit),
    cachePollToken:async(_job,token)=>{calls.cached.push(token);},finish:async(_job,outcome)=>{calls.finish.push(outcome);}};
  const imports={"./credentials":{gmailRoutingRepository:()=>repository,
    connectorAppRepository:()=>({connectorEventRoutes:async({sourceRef})=>routes[sourceRef] ?? []}),
    connectorCredentialRepository:()=>({resolve:async()=>({
    version:1,connectionGeneration:"generation",values:{mailboxes:JSON.stringify([job.selection])}})})},
    "./gmail-mailboxes":{parseMailboxes},"./gmail-poll-client":polling,"./gmail-notification-api":{gmailIncomingChanges},
    "./gmail-watch-client":{},"./http":{ProviderRequestError},
    "./gmail-auto-read":{GMAIL_AUTO_READ_HOURLY_LIMIT:30,autoReadGmailMessage:async(_env,input)=>{
      calls.read.push({...input,current:await input.current()});}},
    "./event-ingress":{connectorEventMessageId:(provider,eventId,channelId)=>`app:${provider}:${eventId}:${channelId}`,appendToRoutes:async(_env,append,_provider,event,targets)=>{
      for(const route of targets)await append(_env,route.channelId,{channelId:route.channelId,body:event.body});}},
    "../product-message-append":{dispatchProductMessageAppend:async(_env,_channel,message)=>{calls.append.push(message);return new Response();}},
    "../automation-triggers":{fireConnectorAutomationTriggers:async(_env,event)=>{calls.automation.push(event);}}};
  const {drainGmailNotifications}=load(name=>imports[name]);
  return {job,state,calls,routes,recent,run:()=>drainGmailNotifications(env)};
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
  assert.doesNotMatch(JSON.stringify(due.calls.append),/private-refresh|private-access/);
});

test("a notification reaches only the Channels its owner subscribed to the mailbox or to every own mailbox",async()=>{
  const due=await drainer();due.job.pendingWake=true;
  due.routes["gmail:me@example.com"].push({channelId:"channel-other",authorityRootUserId:"someone-else",features:["message.received"]},
    {channelId:"channel-muted",authorityRootUserId:"owner",features:[]});
  due.routes["gmail:*"].push({channelId:"channel-all",authorityRootUserId:"owner",features:["message.received"]},
    {channelId:"channel-1",authorityRootUserId:"owner",features:["message.received"]});
  await fetched([{body:counts},{body:{status:200,data:{historyId:"200",history:[{messagesAdded:[
    {message:{id:"abcdef1234567890",labelIds:["INBOX"]}}]}]}}}],due.run);
  assert.deepEqual(due.calls.append.map(message=>message.channelId),["channel-1","channel-all"]);
  assert.equal(due.calls.automation[0].event.sourceRef,"gmail:me@example.com");
  assert.deepEqual(due.calls.finish,["done"]);
  // The connector's own read answers exactly the notifications it just posted, as the mailbox owner.
  assert.equal(due.calls.read.length,1);
  const [read]=due.calls.read;
  assert.equal(read.id,"abcdef1234567890");assert.equal(read.limited,false);assert.equal(read.current,true);
  assert.deepEqual(read.mailbox,{account:"ca_owned",address:"me@example.com",owner:"user:owner"});
  assert.deepEqual(read.notifications,[
    {channelId:"channel-1",messageId:"app:gmail:route-1:abcdef1234567890:channel-1"},
    {channelId:"channel-all",messageId:"app:gmail:route-1:abcdef1234567890:channel-all"}]);
});

test("a mailbox past the hourly limit is notified without an automatic read",async()=>{
  const flooded=await drainer();flooded.job.pendingWake=true;flooded.recent.count=30;
  await fetched([{body:counts},{body:{status:200,data:{historyId:"200",history:[{messagesAdded:[
    {message:{id:"abcdef1234567890",labelIds:["INBOX"]}}]}]}}}],flooded.run);
  assert.equal(flooded.calls.append.length,1);assert.equal(flooded.calls.read[0].limited,true);
  const below=await drainer();below.job.pendingWake=true;below.recent.count=29;
  await fetched([{body:counts},{body:{status:200,data:{historyId:"200",history:[{messagesAdded:[
    {message:{id:"abcdef1234567890",labelIds:["INBOX"]}}]}]}}}],below.run);
  assert.equal(below.calls.read[0].limited,false);
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
  assert.match(gap.calls.append[0].body,/history expired/);assert.equal(gap.calls.automation.length,0);
  assert.deepEqual(gap.calls.finish,["done"]);
});
