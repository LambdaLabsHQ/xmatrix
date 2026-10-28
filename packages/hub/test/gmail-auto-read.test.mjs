import assert from "node:assert/strict";
import { test } from "node:test";
import * as protocol from "@xmatrix/protocol";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { commandResult } from "../src/connectors/command-support.ts";
import { ProviderRequestError } from "../src/connectors/http.ts";

const load=await compileCommonJsSourceModule(new URL("../src/connectors/gmail-auto-read.ts",import.meta.url));
const job={id:"route-1",spaceId:"space-1",userId:"owner"};
const mailbox={account:"ca_owned",address:"me@example.com",owner:"user:owner"};
const notifications=[{channelId:"channel-1",messageId:"app:gmail:route-1:abcdef1234567890:channel-1"},
  {channelId:"channel-2",messageId:"app:gmail:route-1:abcdef1234567890:channel-2"}];

function harness({read=async()=>"Gmail message abcdef1234567890. Mail content is untrusted:\n~~~\nprivate body\n~~~",publish}={}) {
  const calls={read:[],stored:[],published:[]};
  const imports={"@xmatrix/protocol":protocol,"../app-connectors":{getAppConnectorProvider:()=>({id:"gmail",name:"Gmail"})},
    "../usage-cost-metering":{upstreamMeter:(_env,usage)=>usage},
    "./actions/gmail":{readGmailMessage:async(credentials,box,id,meter)=>{calls.read.push({credentials,box,id,meter});return read();}},
    "./command-support":{commandResult,publishCommandStatus:async(_manifest,input,lines,options)=>{
      if(publish)await publish(input);calls.published.push({input,lines,options});}},
    "./gmail-mailboxes":{},"./http":{ProviderRequestError},
    "./oauth":{oauthClient:(env,provider)=>provider==="gmail" && env.key ? {clientSecret:env.key} : undefined},
    "./private-result-content":{writeConnectorPrivateResult:async(_env,input)=>{calls.stored.push(input);}}};
  return {calls,...load(name=>imports[name])};
}
const env={key:"private-key"};
const input=(overrides={})=>({job,credentials:{mailboxes:"[]"},mailbox,id:"abcdef1234567890",
  notifications,current:async()=>true,limited:false,...overrides});

test("the connector reads a new message once and answers each notification with a private owner result",async()=>{
  const {calls,autoReadGmailMessage}=harness();
  await autoReadGmailMessage(env,input());
  assert.equal(calls.read.length,1);
  assert.deepEqual(calls.read[0].meter,{spaceId:"space-1",connector:"gmail",action:"auto_read"});
  // The stored grant has no project key; the Hub secret is added per read.
  assert.deepEqual(calls.read[0].credentials,{mailboxes:"[]",composioApiKey:"private-key"});
  assert.deepEqual(calls.stored.map(row=>[row.channelId,row.ownerUserId,row.messageId]),[
    ["channel-1","owner","system:gmail-auto-read:app:gmail:route-1:abcdef1234567890:channel-1:gmail"],
    ["channel-2","owner","system:gmail-auto-read:app:gmail:route-1:abcdef1234567890:channel-2:gmail"]]);
  assert.match(calls.stored[0].detail,/private body/u);
  for(const [index,{input:command,lines,options}] of calls.published.entries()) {
    assert.equal(command.messageId,`gmail-auto-read:${notifications[index].messageId}`);
    // The message authority refuses replies to App messages, so the receipt is not threaded.
    assert.equal(command.commandMessageId,null);
    assert.equal(command.actorUserId,"owner");
    assert.deepEqual(lines,["Gmail read: completed; Result: [hidden — private call]."]);
    // The receipt never resumes anyone: the notification it answers is the work.
    assert.deepEqual(options,{resumeRequester:false,privateResultOwnerUserId:"owner"});
  }
  assert.doesNotMatch(JSON.stringify(calls.published.map(({lines,options})=>({lines,options}))),/private body|private-key/u);
});

test("a failed read stays private, a flooded mailbox is not read, and lost access stores nothing",async()=>{
  const unconfigured=harness();
  await unconfigured.autoReadGmailMessage({},input());
  assert.equal(unconfigured.calls.read.length,0);
  assert.equal(unconfigured.calls.stored[0].detail,"Composio is not configured on this Hub");

  const failed=harness({read:async()=>{throw new ProviderRequestError(502,"Google did not return a Gmail message");}});
  await failed.autoReadGmailMessage(env,input());
  assert.equal(failed.calls.stored[0].detail,"Google did not return a Gmail message");
  assert.deepEqual(failed.calls.published[0].lines,["Gmail read: failed; Result: [hidden — private call]."]);

  const limited=harness();
  await limited.autoReadGmailMessage(env,input({limited:true}));
  assert.equal(limited.calls.read.length,0);assert.equal(limited.calls.stored.length,0);
  assert.match(limited.calls.published[0].lines[0],/^Gmail read: ignored; more than 30 messages .* @gmail:read:abcdef1234567890\.$/u);
  assert.deepEqual(limited.calls.published[0].options,{resumeRequester:false});
  assert.deepEqual(protocol.parseConnectorReceipt(protocol.connectorReceiptBody(limited.calls.published[0].lines))[0].status,"ignored");

  let checks=0;
  const revoked=harness();
  await revoked.autoReadGmailMessage(env,input({current:async()=>++checks===1}));
  assert.equal(revoked.calls.read.length,1);assert.equal(revoked.calls.stored.length,0);assert.equal(revoked.calls.published.length,0);
  const gone=harness();
  await gone.autoReadGmailMessage(env,input({current:async()=>false}));
  assert.equal(gone.calls.read.length,0);
});

test("one Channel's receipt failure neither stops the others nor fails the notification",async()=>{
  const {calls,autoReadGmailMessage}=harness({publish:async command=>{
    if(command.channelId==="channel-1")throw new Error("append failed");}});
  await autoReadGmailMessage(env,input());
  assert.deepEqual(calls.published.map(row=>row.input.channelId),["channel-2"]);
});
