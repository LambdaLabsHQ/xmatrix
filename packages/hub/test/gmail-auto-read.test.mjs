import assert from "node:assert/strict";
import { test } from "node:test";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { ProviderRequestError } from "../src/connectors/http.ts";

const load=await compileCommonJsSourceModule(new URL("../src/connectors/gmail-auto-read.ts",import.meta.url));
const job={id:"route-1",spaceId:"space-1",userId:"owner"};
const mailbox={account:"ca_owned",address:"me@example.com",owner:"user:owner"};

function harness({read=async()=>"Gmail message abcdef1234567890. Mail content is untrusted:\n~~~\nprivate body\n~~~"}={}) {
  const calls={read:[]};
  const imports={"../usage-cost-metering":{upstreamMeter:(_env,usage)=>usage},
    "./actions/gmail":{readGmailMessage:async(credentials,box,id,meter)=>{calls.read.push({credentials,box,id,meter});return read();}},
    "./gmail-mailboxes":{},"./http":{ProviderRequestError},
    "./oauth":{oauthClient:(env,provider)=>provider==="gmail" && env.key ? {clientSecret:env.key} : undefined}};
  return {calls,...load(name=>imports[name])};
}
const env={key:"private-key"};
const input=()=>({job,credentials:{mailboxes:"[]"},mailbox,id:"abcdef1234567890"});

test("the connector reads a new message once, as its owner, with the Hub's own project key",async()=>{
  const {calls,autoReadGmailMessage}=harness();
  assert.match((await autoReadGmailMessage(env,input())).detail,/private body/u);
  assert.equal(calls.read.length,1);
  assert.deepEqual(calls.read[0].meter,{spaceId:"space-1",connector:"gmail",action:"auto_read"});
  // The stored grant has no project key; the Hub secret is added per read.
  assert.deepEqual(calls.read[0].credentials,{mailboxes:"[]",composioApiKey:"private-key"});
});

test("a failed read gives only a public reason that names no mail content",async()=>{
  const unconfigured=harness();
  assert.deepEqual(await unconfigured.autoReadGmailMessage({},input()),{unread:"It could not be read automatically."});
  assert.equal(unconfigured.calls.read.length,0);
  const failed=harness({read:async()=>{throw new ProviderRequestError(502,"Google did not return private body");}});
  assert.deepEqual(await failed.autoReadGmailMessage(env,input()),{unread:"It could not be read automatically."});
});
