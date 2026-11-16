import assert from "node:assert/strict";
import { test } from "node:test";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { ProviderRequestError } from "../src/connectors/http.ts";
import { readGmailMessage } from "../src/connectors/actions/gmail.ts";
import { reportGmailAutoReadFailure } from "../src/connectors/gmail-read-failure.ts";
import { sentryEventMetadata } from "../src/connectors/actions/sentry-event-metadata.ts";
import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { captureErrorReports, exceptionEvents } from "./support/error-reports.mjs";

const load=await compileCommonJsSourceModule(new URL("../src/connectors/gmail-auto-read.ts",import.meta.url));
const job={id:"route-1",spaceId:"space-1",userId:"owner"};
const mailbox={account:"ca_owned",address:"me@example.com",owner:"user:owner"};

function harness({read=async()=>"Gmail message abcdef1234567890. Mail content is untrusted:\n~~~\nprivate body\n~~~"}={}) {
  const calls={read:[]};
  const imports={"../usage-cost-metering":{upstreamMeter:(_env,usage)=>usage},
    "./actions/gmail":{readGmailMessage:async(credentials,box,id,meter)=>{calls.read.push({credentials,box,id,meter});return read(credentials,box,id);}},
    "./gmail-mailboxes":{},"./http":{ProviderRequestError},
    "./gmail-read-failure":{reportGmailAutoReadFailure},
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

// HUB-BP: only an actual sent envelope after a real Gmail read can prove that
// overloaded 502s remain distinguishable without leaking mail/provider text.
test("automatic read failures retain their phase and origin once, with a content-free issue projection", async t => {
  const envelopes=captureErrorReports(t), transport=globalThis.fetch;
  t.mock.method(console,"warn",()=>{});
  const data={payload:{mimeType:"text/plain",body:{data:Buffer.from("private-mail-body").toString("base64url")}}};
  const external={payload:{mimeType:"text/html",body:{attachmentId:"ANGjdJ_body",size:100}}};
  const timeout=new DOMException("private-timeout-text","TimeoutError");
  const unknown=new Error("private-provider-text\n    at privateField (https://private-host/mail:1:2)");
  unknown.cause=new Error("private-cause");
  unknown.stack="Error: private-provider-text\n    at providerJson (index.js:101:7)\n    at privateField (https://private-host/mail:1:2)";
  const cases=[
    {phase:"message",kind:"http_status",status:"502",replies:[()=>Response.json({error:"private-upstream-error"},{status:502})]},
    {phase:"message",kind:"proxy_contract",status:"502",replies:[()=>new Response("private-invalid-json")]},
    {phase:"message",kind:"provider_status",status:"502",replies:[()=>Response.json({status:502,data:{error:{message:"private-gmail-error"}}})]},
    {phase:"message",kind:"response_too_large",status:"502",replies:[()=>Response.json({status:200,data:{body:"x".repeat(270000)}})]},
    {phase:"external_body",kind:"response_too_large",status:"502",replies:[()=>Response.json({status:200,data:external}),
      ()=>Response.json({status:200,data:{data:"x".repeat(3*1024*1024)}})]},
    {phase:"format",kind:"message_contract",status:"502",replies:[()=>Response.json({status:200,data:{}})]},
    {phase:"message",kind:"timeout",status:"unavailable",replies:[()=>{throw timeout;}]},
    {phase:"message",kind:"unclassified",status:"unavailable",replies:[()=>{throw unknown;}]},
  ];
  let active, calls=0;
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    if(String(url).startsWith("https://backend.composio.dev/")) {
      calls++; assert.ok(active.replies.length,"a failed read must not replay"); return active.replies.shift()();
    }
    return transport(url,init);
  });
  const real=harness({read:readGmailMessage});
  for(const row of cases) {
    active=row;
    assert.deepEqual(await real.autoReadGmailMessage(env,input()),{unread:"It could not be read automatically."});
    await sendErrorReports();
    const events=exceptionEvents(envelopes.splice(0));
    assert.equal(events.length,1,`${row.phase}/${row.kind} owns exactly one event`);
    const event=events[0];
    assert.deepEqual(event.extra,{gmail_read_phase:row.phase,gmail_read_kind:row.kind,gmail_read_status:row.status});
    const metadata=sentryEventMetadata({context:event.extra}).join("\n");
    assert.equal(metadata,`Gmail automatic read failure: ${row.phase} · ${row.kind} · status=${row.status}`);
    assert.doesNotMatch(JSON.stringify(event)+metadata,/private-|ca_owned|me@example|abcdef1234567890/);
    if(row.kind==="unclassified") {
      assert.ok(event.exception.values[0].stacktrace.frames.some(frame=>frame.filename==="app:///index.js" && frame.lineno===101));
    }
  }
  assert.equal(calls,9);
  active={replies:[()=>Response.json({status:200,data})]};
  assert.match((await real.autoReadGmailMessage(env,input())).detail,/private-mail-body/);
  await sendErrorReports();
  assert.equal(exceptionEvents(envelopes).length,0,"a successful read is private content, never an error report");
  for(const invalid of [{gmail_read_phase:"private-phase",gmail_read_kind:"http_status",gmail_read_status:"502"},
    {gmail_read_phase:"message",gmail_read_kind:"private-kind",gmail_read_status:"502"},
    {gmail_read_phase:"message",gmail_read_kind:"http_status",gmail_read_status:"502 private-error"}]) {
    assert.deepEqual(sentryEventMetadata({context:invalid}),[]);
  }
});
