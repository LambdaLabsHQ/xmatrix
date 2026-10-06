import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { test } from "node:test";
import { dingtalkNativeSuite, verifyDingTalkSuiteCallback, dingtalkFlatJson, handleDingTalkSuiteCallback,
  DINGTALK_SUITE_DEPENDENCIES } from "../src/connectors/dingtalk-suite.ts";
import { decryptCallbackEnvelope } from "../src/connectors/aes-callback-envelope.ts";

const key = Buffer.alloc(32, 9), suiteKey = "suitePublicFixtureKey";
const env = { CONNECTOR_DINGTALK_SUITE_KEY: suiteKey, CONNECTOR_DINGTALK_SUITE_SECRET: "public_fixture_secret",
  CONNECTOR_DINGTALK_CALLBACK_TOKEN: "FixtureToken", CONNECTOR_DINGTALK_ENCODING_AES_KEY: key.toString("base64").slice(0,-1) };
const native = await dingtalkNativeSuite(env);
// Independent provider envelope writer: does not call the production encrypt helper.
function encrypted(message, owner = suiteKey, padding = true) {
  const body = Buffer.from(message), size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  const content = Buffer.concat([Buffer.alloc(16, 7), size, body, Buffer.from(owner)]);
  const count = 32 - content.length % 32;
  const bytes = Buffer.concat([content, Buffer.alloc(count, count)]);
  if (!padding) bytes[bytes.length-1] = 0;
  const cipher = createCipheriv("aes-256-cbc",key,key.subarray(0,16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(bytes),cipher.final()]).toString("base64");
}
function request(payload, options = {}) {
  const encrypt = options.encrypt ?? encrypted(typeof payload === "string" ? payload : JSON.stringify(payload), options.owner);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now()/1000)), nonce = "fixture_nonce";
  const signature = createHash("sha1").update([native.token,timestamp,nonce,encrypt].sort().join(""),"utf8").digest("hex");
  const query = new URLSearchParams({signature,timestamp,nonce});
  return new Request(`https://hub.invalid/api/connectors/dingtalk/suite?${query}`, {method:"POST", body:JSON.stringify({encrypt})});
}
const ticket = () => ({SuiteKey:suiteKey,EventType:"suite_ticket",TimeStamp:Math.floor(Date.now()/1000),SuiteTicket:"private_fixture_ticket"});
function fixture(fail = false) {
  const calls=[];
  const dependencies={...DINGTALK_SUITE_DEPENDENCIES,repository:()=>({async acceptTicket(input){
    if(fail)throw Error("private_database_error_ticket");calls.push(input);
  }})};
  return {calls,run:r=>handleDingTalkSuiteCallback(env,r,dependencies)};
}
async function responsePlain(response) {
  assert.equal(response.status,200); assert.equal(response.headers.get("cache-control"),"no-store");
  const body=await response.json(); assert.deepEqual(Object.keys(body).sort(),["encrypt","msg_signature","nonce","timeStamp"]);
  const url=new URL("https://hub.invalid");url.search=new URLSearchParams({msg_signature:body.msg_signature,timeStamp:body.timeStamp,nonce:body.nonce});
  return verifyDingTalkSuiteCallback(native,url.href,body.encrypt);
}

test("DingTalk matches the official Python SDK's published encrypted check_url vector",()=>{
  const vectorNative={app:{suiteKey:"ding6ccabc44d2c8d38b"},token:"mryue",aesKey:"Yue0EfdN5900c1ce5cf6A152c63DDe1808a60c5ecd7"};
  const encryptedVector="0vJiX6vliEpwG3U45CtXqi+m8PXbQRARJ8p8BbDuD1EMTDf0jKpQ79QS93qEk7XHpP6u+oTTrd15NRPvNvmBKyDCYxxOK+HZeKju4yhELOFchzNukR+t8SB/qk4ROMu3";
  assert.equal(verifyDingTalkSuiteCallback(vectorNative,"https://hub.invalid?signature=03044561471240d4a14bb09372dfcfd4fd0e40cb&timestamp=1608001896814&nonce=WL4PK6yA",encryptedVector,1608001896814),'{"EventType":"check_url"}');
});
test("DingTalk requires one complete canonical identity and atomic key rotation",async()=>{
  assert.equal(await dingtalkNativeSuite({}),undefined);
  for(const name of Object.keys(env)) {
    const missing={...env};delete missing[name];await assert.rejects(dingtalkNativeSuite(missing),{status:503});
    await assert.rejects(dingtalkNativeSuite({...env,[name]:env[name]+"\n"}),{status:503});
    const rotated=name.endsWith("AES_KEY")?Buffer.alloc(32,4).toString("base64").slice(0,-1):env[name]+"x";
    assert.notEqual(JSON.stringify((await dingtalkNativeSuite({...env,[name]:rotated})).app),JSON.stringify(native.app));
  }
  await assert.rejects(dingtalkNativeSuite({...env,CONNECTOR_DINGTALK_ENCODING_AES_KEY:"x".repeat(43)}),{status:503});
});
test("challenge and key-specific update checks return encrypted provider responses without granting anything",async()=>{
  const {run,calls}=fixture();assert.equal(await responsePlain(await run(request({EventType:"check_url"}))),"success");
  for(const EventType of ["check_create_suite_url","check_update_suite_url"])
    assert.equal(await responsePlain(await run(request({EventType,TestSuiteKey:suiteKey,Random:"requested_random"}))),"requested_random");
  assert.equal(calls.length,0);
  assert.equal((await run(request({EventType:"check_update_suite_url",TestSuiteKey:"other_suite",Random:"random"}))).status,401);
});
test("tickets are persisted before encrypted success; normalize documented ticket event spelling",async()=>{
  const {run,calls}=fixture();const payload=ticket();assert.equal(await responsePlain(await run(request(payload))),"success");
  assert.equal(await responsePlain(await run(request({...payload,EventType:"suite_ticket "}))),"success");
  assert.equal(calls.length,2);assert.equal(calls[0].eventId,calls[1].eventId);assert.equal(calls[0].ticket,payload.SuiteTicket);
  assert.equal(calls[0].app.suiteKey,suiteKey);assert.equal(calls[0].eventId.length,64);
  const failed=await fixture(true).run(request(payload));assert.equal(failed.status,503);
  assert.doesNotMatch(await failed.text(),/private_database|private_fixture_ticket/);
});
test("callback authentication rejects wrong signatures, receivers, stale/future timestamps and ambiguous query aliases",async()=>{
  const {run,calls}=fixture();const valid=request(ticket());const original=await valid.text();
  for(const query of ["signature=bad&timestamp=1700000000&nonce=n",new URL(valid.url).searchParams+"&signature=duplicate",
    new URL(valid.url).searchParams+"&msg_signature=duplicate",new URL(valid.url).searchParams+"&timeStamp=duplicate",
    new URL(valid.url).searchParams+"&nonce=duplicate"]) {
    assert.equal((await run(new Request("https://hub.invalid?"+query,{method:"POST",body:original}))).status,401);
  }
  for(const delta of [-601000,31000])assert.equal((await run(request(ticket(),{timestamp:String(Date.now()+delta)}))).status,401);
  assert.equal((await run(request(ticket(),{owner:"other_suite"}))).status,401);
  assert.equal((await run(request(ticket(),{encrypt:encrypted(JSON.stringify(ticket()),suiteKey,false)}))).status,401);
  assert.equal(calls.length,0);
});
test("flat authenticated JSON rejects duplicate/escaped keys, trailing commas, nested values and unsafe numbers",()=>{
  for(const body of ['{"SuiteKey":"a","SuiteKey":"b"}','{"SuiteKey":"a","Suite\\u004bey":"b"}',
    '{"n":9007199254740993}','{"n":1.2}','{"n":1,}','{"n":{}}','{"n":[]}','{"n":null}','{"n":true}','{}'])
    assert.throws(()=>dingtalkFlatJson(body),{status:401});
  assert.equal(dingtalkFlatJson(' { "n" : 12, "s": "quote\\\"你好" } ').s,'quote"你好');
});
test("bodies, suite fields, unsupported installation/lifecycle events and unavailable storage never acknowledge success",async()=>{
  const {run,calls}=fixture();
  assert.equal((await handleDingTalkSuiteCallback({},request(ticket()))).status,503);
  assert.equal((await run(new Request("https://hub.invalid",{method:"GET"}))).status,405);
  assert.equal((await run(new Request("https://hub.invalid",{method:"POST",body:"x".repeat(32769)}))).status,413);
  const payload=ticket();for(const bad of [{...payload,SuiteKey:"other_suite"},{...payload,SuiteTicket:"bad\nvalue"},
    {...payload,SpaceId:"caller_space"},{...payload,TimeStamp:Date.now()+31000}])assert.equal((await run(request(bad))).status,401);
  for(const EventType of ["tmp_auth_code","suite_relieve","change_auth","robot_message"])
    assert.equal((await run(request({...payload,EventType}))).status,503);
  assert.equal(calls.length,0);
});
test("AES response length is UTF-8 bytes and rejects authenticated corrupt envelopes",()=>{
  assert.equal(decryptCallbackEnvelope(native.aesKey,suiteKey,encrypted("你好")),"你好");
  for(const body of ["bad",encrypted("message")+"="," "+encrypted("message")])assert.throws(()=>decryptCallbackEnvelope(native.aesKey,suiteKey,body),{status:401});
});
