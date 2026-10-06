import assert from "node:assert/strict";
import { test } from "node:test";
import { wecomCompanyApi, requestWeComSuiteToken } from "../src/connectors/wecom-company-api.ts";
import { wecomActionCapability, verifyWeComNativeConnection, WECOM_NATIVE_DEPENDENCIES } from "../src/connectors/wecom-native.ts";
import { wecomRecipientRef } from "@xmatrix/db";
const grant={corpId:"wpCompany",agentId:1000001,permanentCode:"private-permanent-code"};
function fixture(change=()=>{}) {
  const calls=[],auth={errcode:0,auth_corp_info:{corpid:grant.corpId},auth_info:{agent:[{agentid:grant.agentId,auth_mode:0,privilege:{level:1,allow_user:["MemberOne"]}}]}};
  const request=async(url,init={})=>{
    const path=new URL(url).pathname.split('/cgi-bin/')[1];calls.push({path,url:String(url),body:init.json});
    let result=path==='service/get_pre_auth_code'?{errcode:0,pre_auth_code:'public-preauth-code',expires_in:1200}:
      path==='service/set_session_info'?{errcode:0}:
      path==='service/v2/get_permanent_code'?{errcode:0,permanent_code:grant.permanentCode,auth_corp_info:{corpid:grant.corpId}}:
      path==='service/v2/get_auth_info'?structuredClone(auth):
      path==='service/get_corp_token'?{access_token:'private-corp-token',expires_in:7200}:
      path==='agent/get_permissions'?{errcode:0,app_permissions:['contact:base:base']}:
      path.startsWith('agent/get?')?{errcode:0,agentid:grant.agentId,close:0}:
      path.startsWith('user/get?')?{errcode:0,userid:'MemberOne',open_userid:'MemberOne',status:1}:
      path==='message/send'?{errcode:0,msgid:'provider-confirmed-msgid'}:null;
    // URL.pathname excludes the member/agent query.
    if(path==='agent/get')result={errcode:0,agentid:grant.agentId,close:0};
    if(path==='user/get')result={errcode:0,userid:'MemberOne',open_userid:'MemberOne',status:1};
    assert.ok(result,path);change(path,result);return result;
  };
  return {calls,api:wecomCompanyApi('private-suite-token',request)};
}
test("native WeCom uses website preauthorization, v2 exchange without obsolete auth_info and separate live authorization",async()=>{
  const f=fixture();assert.equal(await f.api.preauthorization(true),'public-preauth-code');
  assert.deepEqual(f.calls[1].body,{pre_auth_code:'public-preauth-code',session_info:{auth_type:1}});
  assert.deepEqual(await f.api.exchange('c'.repeat(64)),grant);
  assert.deepEqual(f.calls.slice(2).map(c=>c.path),['service/v2/get_permanent_code','service/v2/get_auth_info']);
  for(const code of ['short','c'.repeat(513)])await assert.rejects(f.api.exchange(code));
  await f.api.check(grant,['memberone']);assert.ok(f.calls.some(c=>c.path==='agent/get_permissions'));
  assert.ok(f.calls.every(c=>new URL(c.url).origin==='https://qyapi.weixin.qq.com'));
});
test("WeCom rejects wrong company, shared/customized/member authorization, stale permissions and invisible members",async()=>{
  const changes=[
    (path,p)=>{if(path==='service/v2/get_auth_info')p.auth_corp_info.corpid='otherCompany';},
    (path,p)=>{if(path==='service/v2/get_auth_info')p.auth_info.agent[0].auth_mode=1;},
    (path,p)=>{if(path==='service/v2/get_auth_info')p.auth_info.agent[0].shared_from={corpid:'anotherCorp'};},
    (path,p)=>{if(path==='service/v2/get_auth_info')p.auth_info.agent[0].is_customized_app=true;},
    (path,p)=>{if(path==='service/v2/get_auth_info')p.auth_info.agent[0].privilege.allow_user=['@ALL'];},
    (path,p)=>{if(path==='agent/get_permissions')p.app_permissions=['contact:edit:all'];},
    (path,p)=>{if(path==='agent/get_permissions')p.app_permissions_ext=[{permission_name:'contact:base:base',expire_time:Math.floor(Date.now()/1000)-1}];},
    (path,p)=>{if(path==='agent/get')p.close=1;},
    (path,p)=>{if(path==='user/get')p.userid='otherMember';},
    (path,p)=>{if(path==='user/get')p.status=2;},
  ];
  for(const change of changes){const f=fixture(change);await assert.rejects(f.api.send(grant,'MemberOne','hello',async()=>{}));assert.ok(!f.calls.some(c=>c.path==='message/send'));}
  const f=fixture();for(const recipient of ['@all','@ALL','otherMember'])await assert.rejects(f.api.check(grant,[recipient]));
});
test("WeCom writes target exactly one confirmed member and recheck local authority immediately before native send",async()=>{
  const f=fixture();let before=0;await f.api.send(grant,'MemberOne','hello',async()=>{before++;});assert.equal(before,1);
  assert.deepEqual(f.calls.at(-1).body,{touser:'MemberOne',agentid:grant.agentId,msgtype:'text',text:{content:'hello'},safe:0});
  const denied=fixture();await assert.rejects(denied.api.send(grant,'MemberOne','hello',async()=>{throw Error('retired');}),/retired/);
  assert.ok(!denied.calls.some(c=>c.path==='message/send'));
  for(const text of ['','😀'.repeat(513),'bad\u0000text'])await assert.rejects(f.api.send(grant,'MemberOne',text,async()=>{}),{status:400});
});
test("native partial recipient/license failures and ambiguous send errors never report success or retry",async()=>{
  for(const field of ['invaliduser','invalidparty','invalidtag','unlicenseduser']){
    const f=fixture((path,p)=>{if(path==='message/send')p[field]='private-member-error';});
    await assert.rejects(f.api.send(grant,'MemberOne','hello',async()=>{}),error=>error.status===502&&!error.message.includes('private-member'));
    assert.equal(f.calls.filter(c=>c.path==='message/send').length,1);
  }
  let calls=0;const api=wecomCompanyApi('private-suite-token',async()=>{calls++;throw Error('private-token-and-provider-error');});
  await assert.rejects(api.exchange('c'.repeat(64)),e=>e.status===502&&!e.message.includes('private-token'));assert.equal(calls,1);
});
test("suite tokens require actual native ticket and successful bounded provider expiry",async()=>{
  const input={suiteId:'ww0123456789abcdef',suiteSecret:'private-suite-secret',ticket:'private-suite-ticket'};
  const seen=[];const result=await requestWeComSuiteToken(input,async(url,options)=>{seen.push({url,body:options.json});return {suite_access_token:'private-suite-token',expires_in:7200};});
  assert.deepEqual(result,{value:'private-suite-token',expiresIn:7200});assert.deepEqual(seen[0].body,{suite_id:input.suiteId,suite_secret:input.suiteSecret,suite_ticket:input.ticket});
  for(const expires_in of [0,7201,'7200'])await assert.rejects(requestWeComSuiteToken(input,async()=>({suite_access_token:'private-suite-token',expires_in})),{status:502});
});
test("typed WeCom capability exposes no token or permanent code and rejects retired/local out-of-range grants",async()=>{
  const installation={...grant,members:['memberone'],spaceId:'space',connectionId:'space:wecom',appIdentity:'wecom|ww0123456789abcdef|'+'a'.repeat(64),
    companyDigest:'b'.repeat(64),grantGeneration:crypto.randomUUID(),connectionGeneration:'generation'};
  const calls=[];let active=true,checks=0;
  const deps={...WECOM_NATIVE_DEPENDENCIES,native:async()=>({app:{suiteId:'ww0123456789abcdef',eventKeyDigest:'a'.repeat(64)}}),
    companies:()=>({resolve:async()=>installation,current:async()=>active,suiteToken:async()=>({value:'private-suite-token'})}),
    client:()=>({send:async(value,member,text,before)=>{checks++;await before();calls.push({member,text});}})};
  const capability=await wecomActionCapability({},'space',async()=>{},deps);assert.deepEqual(Object.keys(capability),['sendMessage']);
  const ref=await wecomRecipientRef(installation,'memberone');await capability.sendMessage(ref,'hello');assert.deepEqual(calls,[{member:'memberone',text:'hello'}]);
  await assert.rejects(capability.sendMessage('member-'+'f'.repeat(64),'hello'),{status:403});active=false;
  await assert.rejects(capability.sendMessage(ref,'hello'),{status:409});assert.equal(checks,1);
  assert.equal(await verifyWeComNativeConnection({},'space',{...deps,credentials:()=>({resolve:async()=>({values:{webhookKey:'manual'}})})}),false);
});
