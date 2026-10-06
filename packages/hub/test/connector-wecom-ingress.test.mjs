import assert from "node:assert/strict";
import { test } from "node:test";
import { handleWeComAppDelivery, WECOM_INGRESS_DEPENDENCIES } from "../src/connectors/wecom-ingress.ts";
import { env, native, post, xml, seconds } from "./support/wecom-callback.fixture.mjs";
const target={corpId:"wpCompany",agentId:1000001,permanentCode:"private-permanent-code",members:["memberone"],spaceId:"chosen",connectionId:"chosen:wecom",
  appIdentity:`wecom|${native.app.suiteId}|${native.app.eventKeyDigest}`,companyDigest:"b".repeat(64),grantGeneration:crypto.randomUUID(),connectionGeneration:"generation"};
const message=extra=>({ToUserName:target.corpId,FromUserName:"MemberOne",CreateTime:seconds(),MsgType:"text",Content:"private-native-content",MsgId:"18446744073709551615",AgentID:String(target.agentId),...extra});
function fixture() {
  const state={active:true,targets:[target],fail:false},calls=[];
  const dependencies={...WECOM_INGRESS_DEPENDENCIES,companies:()=>({routes:async value=>{calls.push(['route',value]);return state.targets;},current:async()=>state.active}),
    apps:()=>({}),deliver:async(...args)=>{calls.push(['deliver',args.slice(3)]);if(state.fail)throw Error('private-delivery-error');},
    automations:async(_env,value)=>{calls.push(['automation',value]);},append:async()=>new Response(null,{status:200})};
  return {state,calls,handle:request=>handleWeComAppDelivery(env,request,dependencies)};
}
test("signed native WeCom text notifies only current company/member grants without disclosing content or private ids",async()=>{
  const f=fixture(),response=await f.handle(post(xml(message()),{ToUserName:native.app.suiteId,AgentID:String(target.agentId)}));
  assert.equal(await response.text(),'success');assert.equal(f.calls.filter(c=>c[0]==='deliver').length,1);
  const route=f.calls.find(c=>c[0]==='route')[1];assert.equal(route.corpId,target.corpId);assert.equal(route.memberId,'MemberOne');assert.ok(Date.parse(route.eventTime));
  const effects=f.calls.filter(c=>c[0]!=='route');assert.doesNotMatch(JSON.stringify(effects),/private-native-content|private-permanent-code|wpCompany|MemberOne/);
  const delivery=effects.find(c=>c[0]==='deliver')[1];assert.match(delivery[2].eventId,/^[a-f0-9]{64}$/);assert.match(delivery[2].sourceRef,/^wecom:member-[a-f0-9]{64}$/);
  assert.deepEqual(delivery.at(-1),{appIdentity:target.appIdentity,companyDigest:target.companyDigest,grantGeneration:target.grantGeneration});
  await f.handle(post(xml(message())));assert.equal(f.calls.filter(c=>c[0]==='deliver')[0][1][2].eventId,f.calls.filter(c=>c[0]==='deliver')[1][1][2].eventId);
});
test("retired, unbound or unavailable WeCom grants never deliver; failed effects are not acknowledged as successful",async()=>{
  const retired=fixture();retired.state.active=false;assert.equal((await retired.handle(post(xml(message())))).status,200);assert.ok(!retired.calls.some(c=>['deliver','automation'].includes(c[0])));
  const missing=fixture();missing.state.targets=[];assert.equal((await missing.handle(post(xml(message())))).status,200);assert.ok(!missing.calls.some(c=>c[0]==='deliver'));
  const failed=fixture();failed.state.fail=true;const response=await failed.handle(post(xml(message())));assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private-delivery-error|private-native-content/);
  assert.ok(!failed.calls.some(c=>c[0]==='automation'));
});
test("invalid native company identity, pre-grant timestamps, nested XML or suite receiver cannot notify",async()=>{
  for(const extra of [{ToUserName:'invalid:company'},{FromUserName:'@ALL'},{AgentID:'9007199254740992'},{CreateTime:'1'},{CreateTime:String(Math.floor(Date.now()/1000)-601)},{MsgId:'1e20'},{Content:''}]){
    const f=fixture();assert.equal((await f.handle(post(xml(message(extra))))).status,401);assert.equal(f.calls.length,0);
  }
  for(const outer of [{ToUserName:target.corpId},{AgentID:'1'}]){const f=fixture();assert.equal((await f.handle(post(xml(message()),outer))).status,401);assert.equal(f.calls.length,0);}
  const f=fixture();assert.equal((await f.handle(post(xml(message()).replace('</xml>','<Nested><Child>secret</Child></Nested></xml>')))).status,401);
  assert.equal((await handleWeComAppDelivery({},post(xml(message())))).status,503);
});
