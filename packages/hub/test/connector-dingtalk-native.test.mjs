import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dingtalkRecipientRef} from '@xmatrix/db';
import {dingtalkActionCapability,verifyDingTalkNativeConnection} from '../src/connectors/dingtalk-native.ts';
import {DINGTALK_ACTIONS} from '../src/connectors/actions/chat-webhooks.ts';
function fixture() {
  const state={current:true,allowed:true,manual:false,appId:34576},calls=[];
  const installation={corpId:'dingCompanyFixture',appId:34576,agentId:987654,members:['MemberCase'],spaceId:'original',connectionId:'original:dingtalk',
    appIdentity:'dingtalk|suiteFixture|'+ 'a'.repeat(64),companyDigest:'b'.repeat(64),connectionGeneration:'birth',grantGeneration:crypto.randomUUID(),actorUserId:'original-owner'};
  const deps={native:async()=>({app:{suiteKey:'suiteFixture'},appId:state.appId,template:{id:'approved',textField:'text'}}),
    companies:()=>({resolve:async()=>installation,current:async()=>state.current}),credentials:()=>({resolve:async()=>state.manual?{}:null}),
    client:()=>({check:async(_grant,current)=>{await current();calls.push('check');},readMember:async(_grant,recipient,current)=>{await current();calls.push('read');return {memberId:recipient,name:'Minimal',active:true};},
      sendTemplate:async(_grant,recipient,text,template,current)=>{await current();calls.push({recipient,text,template});return {taskId:12345,summary:'Accepted; delivery is not confirmed'};}})};
  const authorize=async()=>{if(!state.allowed)throw Object.assign(Error('Denied'),{status:403});};
  return {state,calls,installation,deps,authorize};
}
test('DingTalk native recipient is bound to original Space/grant and primary current rights/policy at effect time',async()=>{
  const f=fixture(),capability=await dingtalkActionCapability({},'original',f.authorize,f.deps),recipient=await dingtalkRecipientRef(f.installation,'MemberCase');
  await assert.rejects(capability.sendMessage(await dingtalkRecipientRef({...f.installation,spaceId:'other'},'MemberCase'),'private text'),e=>e.status===403);
  await assert.rejects(capability.readMember(await dingtalkRecipientRef({...f.installation,grantGeneration:crypto.randomUUID()},'MemberCase')),e=>e.status===403);
  f.state.current=false;await assert.rejects(capability.readMember(recipient),e=>e.status===409);
  f.state.current=true;f.state.allowed=false;await assert.rejects(capability.sendMessage(recipient,'private text'),e=>e.status===403);assert.equal(f.calls.length,0);
  f.state.allowed=true;assert.deepEqual(await capability.readMember(recipient),{memberId:'MemberCase',name:'Minimal',active:true});
  const sent=await capability.sendMessage(recipient,'explicit text');assert.equal(sent.taskId,12345);assert.match(sent.summary,/not confirmed/);
  f.state.appId=111;await assert.rejects(dingtalkActionCapability({},'original',f.authorize,f.deps),e=>e.status===409);
});
test('DingTalk Check uses current company grant while manual robot credentials retain separate verification',async()=>{
  const f=fixture();assert.equal(await verifyDingTalkNativeConnection({},'original',f.deps),true);
  f.state.current=false;await assert.rejects(verifyDingTalkNativeConnection({},'original',f.deps),e=>e.status===409);
  f.state.manual=true;assert.equal(await verifyDingTalkNativeConnection({},'original',f.deps),false);assert.deepEqual(f.calls,['check']);
});
test('DingTalk native read/send never fall back to a manual robot token',async()=>{
  const recipient='member-'+ 'a'.repeat(64),credentials={accessToken:'robot_fixture_token'};
  await assert.rejects(DINGTALK_ACTIONS.read.execute({credentials},{recipient}),e=>e.status===409);
  await assert.rejects(DINGTALK_ACTIONS.send.execute({credentials},{recipient,text:'text'}),e=>e.status===409);
  assert.equal(typeof DINGTALK_ACTIONS.send.parse({target:'@all',text:'text'}),'string');
});
