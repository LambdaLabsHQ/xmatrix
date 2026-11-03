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
  const calls={finish:[],stage:[],append:[],automation:[],cached:[],searched:0,read:[],stored:[]};
  const autoRead={result:{detail:"private body"}};
  // The owner's subscription to this mailbox; tests add others.
  const routes={"gmail:me@example.com":[{channelId:"channel-1",authorityRootUserId:"owner",features:["message.received"]}],"gmail:*":[]};
  let pending=[];
  const state={current:true};
  const repository={cleanup:async()=>{},claim:async()=>[job],current:async()=>state.current,polled:async()=>{},
    pending:async()=>pending,stage:async(_job,ids,historyId,pageToken)=>{calls.stage.push({ids,historyId,pageToken});pending=[...ids];},
    delivered:async(_job,id)=>{pending=pending.filter(item=>item!==id);},searched:async()=>{calls.searched++;},
    cachePollToken:async(_job,token)=>{calls.cached.push(token);},finish:async(_job,outcome)=>{calls.finish.push(outcome);}};
  const imports={"./credentials":{gmailRoutingRepository:()=>repository,
    connectorAppRepository:()=>({connectorEventRoutes:async({sourceRef})=>routes[sourceRef] ?? []}),
    connectorCredentialRepository:()=>({resolve:async()=>({
    version:1,connectionGeneration:"generation",values:{mailboxes:JSON.stringify([job.selection])}})})},
    "./gmail-mailboxes":{parseMailboxes},"./gmail-poll-client":polling,"./gmail-notification-api":{gmailIncomingChanges},
    "./gmail-watch-client":{},"./http":{ProviderRequestError},
    "./gmail-auto-read":{autoReadGmailMessage:async(_env,input)=>{
      calls.read.push(input);return typeof autoRead.result==="function" ? autoRead.result() : autoRead.result;}},
    "./private-result-content":{writeConnectorPrivateResult:async(_env,input)=>{calls.stored.push(input);}},
    "./event-ingress":{connectorEventMessageId:(provider,eventId,channelId)=>`app:${provider}:${eventId}:${channelId}`,
      appendToRoutes:async(_env,append,provider,event,targets,appMetadata)=>{
      for(const route of targets)await append(_env,route.channelId,{channelId:route.channelId,body:event.body,
        messageId:`app:${provider}:${event.eventId}:${route.channelId}`,appMetadata,stored:calls.stored.length});}},
    "../product-message-append":{dispatchProductMessageAppend:async(_env,_channel,message)=>{calls.append.push(message);return new Response();}},
    "../automation-triggers":{fireConnectorAutomationTriggers:async(_env,event)=>{calls.automation.push(event);}}};
  const {drainGmailNotifications}=load(name=>imports[name]);
  return {job,state,calls,routes,autoRead,run:()=>drainGmailNotifications(env)};
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
  // One message per Channel: the notification carries the connector's own read, as the mailbox owner.
  assert.equal(due.calls.read.length,1);
  const [read]=due.calls.read;
  assert.equal(read.id,"abcdef1234567890");
  assert.deepEqual(read.mailbox,{account:"ca_owned",address:"me@example.com",owner:"user:owner"});
  assert.deepEqual(due.calls.stored.map(row=>[row.channelId,row.ownerUserId,row.messageId,row.detail]),[
    ["channel-1","owner","app:gmail:route-1:abcdef1234567890:channel-1","private body"],
    ["channel-all","owner","app:gmail:route-1:abcdef1234567890:channel-all","private body"]]);
  // Both copies are stored before either notification names them.
  assert.deepEqual(due.calls.append.map(message=>message.stored),[2,2]);
  for(const message of due.calls.append) {
    assert.deepEqual(message.appMetadata,{xmatrixPrivateConnectorResultOwner:"owner"});
    assert.equal(message.body,"A new Gmail message is available in me@example.com. Read it with @gmail:read:abcdef1234567890.");
  }
  assert.doesNotMatch(JSON.stringify([due.calls.append,due.calls.automation]),/private body/u);
});

test("an unread message is notified with its public reason and no private result",async()=>{
  const failed=await drainer();failed.job.pendingWake=true;failed.autoRead.result={unread:"It could not be read automatically."};
  await fetched([{body:counts},{body:{status:200,data:{historyId:"200",history:[{messagesAdded:[
    {message:{id:"abcdef1234567890",labelIds:["INBOX"]}}]}]}}}],failed.run);
  assert.equal(failed.calls.stored.length,0);assert.equal(failed.calls.append[0].appMetadata,undefined);
  assert.match(failed.calls.append[0].body,/@gmail:read:abcdef1234567890\. It could not be read automatically\.$/u);
  assert.deepEqual(failed.calls.finish,["done"]);
});

test("access lost while Gmail answers stores and posts nothing",async()=>{
  const revoked=await drainer();revoked.job.pendingWake=true;
  revoked.autoRead.result=()=>{revoked.state.current=false;return {detail:"private body"};};
  await fetched([{body:counts},{body:{status:200,data:{historyId:"200",history:[{messagesAdded:[
    {message:{id:"abcdef1234567890",labelIds:["INBOX"]}}]}]}}}],revoked.run);
  assert.equal(revoked.calls.stored.length,0);assert.equal(revoked.calls.append.length,0);
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
