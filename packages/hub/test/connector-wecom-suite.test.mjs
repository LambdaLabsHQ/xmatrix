import assert from "node:assert/strict";
import { test } from "node:test";
import { handleWeComSuiteCallback, verifyWeComSuiteCallback, wecomNativeSuite, WECOM_SUITE_DEPENDENCIES } from "../src/connectors/wecom-suite.ts";
import { env, native, encrypted, url, xml, payload, post, seconds } from "./support/wecom-callback.fixture.mjs";
function fixture(fail = false) {
  const calls = [];
  const dependencies = { ...WECOM_SUITE_DEPENDENCIES, repository: () => ({ async acceptTicket(value) { if (fail) throw Error("private-error-ticket"); calls.push(value); } }) };
  return { calls, handle: request => handleWeComSuiteCallback(env,request,dependencies) };
}
test("WeCom registration keys are optional together, format checked and rotation changes private app identity", async () => {
  assert.equal(await wecomNativeSuite({}), undefined);
  for (const field of Object.keys(env)) for (const value of [undefined,"unsafe\nvalue"]) await assert.rejects(wecomNativeSuite({...env,[field]:value}),{status:503});
  await assert.rejects(wecomNativeSuite({...env,CONNECTOR_WECOM_ENCODING_AES_KEY:"x".repeat(43)}),{status:503});
  for (const [name,value] of [["SUITE_ID","wx1123456789abcdef"],["SUITE_SECRET","replacement_secret"],["CALLBACK_TOKEN","ReplacementToken"],["ENCODING_AES_KEY",Buffer.alloc(32,9).toString("base64").slice(0,-1)]]) {
    assert.notEqual(JSON.stringify((await wecomNativeSuite({...env,[`CONNECTOR_WECOM_${name}`]:value})).app),JSON.stringify(native.app));
  }
});
test("WeCom URL challenge interoperates with 32-byte PKCS7 lengths and never reaches database", async () => {
  const f=fixture();
  for(let n=1;n<=32;n++) {
    const message="c".repeat(n), cipher=encrypted(message);
    assert.equal(verifyWeComSuiteCallback(native,url(cipher),cipher),message);
    const response=await f.handle(new Request(url(cipher)+`&echostr=${encodeURIComponent(cipher)}`));
    assert.equal(response.status,200); assert.equal(await response.text(),message); assert.equal(response.headers.get("cache-control"),"no-store");
  }
  assert.equal(f.calls.length,0);
});
test("WeCom rejects stale/future/ambiguous queries, substituted suites, invalid length, UTF8 and wrong token", () => {
  const cipher=encrypted("hello");
  for(const value of ["1",String(Math.floor(Date.now()/1000)-601),String(Math.floor(Date.now()/1000)+32)]) assert.throws(()=>verifyWeComSuiteCallback(native,url(cipher,value),cipher),{status:401});
  assert.throws(()=>verifyWeComSuiteCallback(native,url(cipher)+"&timestamp="+seconds(),cipher),{status:401});
  assert.throws(()=>verifyWeComSuiteCallback(native,url(cipher,seconds(),"WrongToken"),cipher),{status:401});
  for(const invalid of [encrypted("hello","wwother1234567890"),encrypted("hello",native.app.suiteId,b=>{b.writeUInt32BE(99999,16);return b;}),encrypted(Buffer.from([255,254])),encrypted("hello",native.app.suiteId,b=>b,true)]) {
    assert.throws(()=>verifyWeComSuiteCallback(native,url(invalid),invalid),{status:401});
  }
  assert.throws(()=>verifyWeComSuiteCallback(native,url(cipher),cipher.slice(0,-4)+"AAAA"),{status:401});
});
test("WeCom suite ticket is authenticated, exact-suite scoped and committed before success", async () => {
  const f=fixture(), response=await f.handle(post(xml(payload({SuiteTicket:"private-fixture-ticket+/=&"})),{ToUserName:native.app.suiteId}));
  assert.equal(response.status,200); assert.equal(await response.text(),"success"); assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].ticket,"private-fixture-ticket+/=&");assert.equal(f.calls[0].app.suiteId,native.app.suiteId);assert.match(f.calls[0].eventId,/^[a-f0-9]{64}$/);
  const failed=fixture(true), result=await failed.handle(post(xml(payload())));assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/private-error-ticket|private-fixture-ticket/);
});
test("WeCom never resolves DTD/entities/duplicates/attributes/nesting or misroutes application callbacks", async () => {
  const f=fixture(), good=xml(payload());
  for(const plaintext of [good.replace('<xml>','<!DOCTYPE xml [<!ENTITY leak SYSTEM "file:///tmp/secret">]><xml>'),good.replace('</xml>','<SuiteId>other</SuiteId></xml>'),good.replace('<SuiteTicket><![CDATA[private-fixture-ticket]]></SuiteTicket>','<SuiteTicket>&leak;</SuiteTicket>'),good.replace('<xml>','<xml attr="1">'),good.replace('</xml>','<Nested><Child>value</Child></Nested></xml>'),xml(payload({SuiteId:"wwother1234567890"})),xml(payload({TimeStamp:"1"})),xml(payload({SuiteTicket:"t".repeat(513)}))]) assert.equal((await f.handle(post(plaintext))).status,401);
  for(const outer of [{ToUserName:"other"},{AgentID:"1"}]) assert.equal((await f.handle(post(good,outer))).status,401);
  assert.equal(f.calls.length,0);
});
test("WeCom registration endpoint does not acknowledge Marketplace install codes or business messages", async () => {
  const f=fixture();
  for(const InfoType of ["create_auth","message"]) assert.equal((await f.handle(post(xml(payload({InfoType}))))).status,503);
  for(const InfoType of ["change_auth","cancel_auth"]) assert.equal((await f.handle(post(xml(payload({InfoType}))))).status,401);
  assert.equal(f.calls.length,0);
  assert.equal((await handleWeComSuiteCallback({},new Request("https://hub.example.test/api/connectors/wecom/suite"))).status,503);
  const oversized=new Request("https://hub.example.test/api/connectors/wecom/suite",{method:"POST",body:"x".repeat(32769)});
  assert.equal((await f.handle(oversized)).status,413);
});
test("native company visibility/cancellation callbacks close primary grants before acknowledgement", async () => {
  const calls=[];
  const dependencies={...WECOM_SUITE_DEPENDENCIES,companies:()=>({async retire(value){calls.push(value);}})};
  for(const InfoType of ["change_auth","cancel_auth"]) {
    const response=await handleWeComSuiteCallback(env,post(xml({SuiteId:native.app.suiteId,InfoType,TimeStamp:seconds(),AuthCorpId:"wpCompanyOpaque"})),dependencies);
    assert.equal(await response.text(),"success");
  }
  assert.equal(calls.length,2); assert.equal(calls[0].corpId,"wpCompanyOpaque");
  const failed=await handleWeComSuiteCallback(env,post(xml({SuiteId:native.app.suiteId,InfoType:"cancel_auth",TimeStamp:seconds(),AuthCorpId:"wpCompanyOpaque"})),
    {...dependencies,companies:()=>({async retire(){throw Error("private-company-error");}})});
  assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/private-company-error/);
});
