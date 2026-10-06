const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),ts=require('typescript');
const output=ts.transpileModule(fs.readFileSync(__dirname+'/dingtalk-installation-values.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const values={};new Function('exports',output)(values);
const state='a'.repeat(64),valid=`state=${state}&authCode=one_use_fixture_code`;
test('DingTalk redirect rejects success plus provider error, aliases and duplicate values',()=>{
  assert.deepEqual(values.dingtalkConsentRedirect(new URLSearchParams(valid)),{state,authCode:'one_use_fixture_code'});
  for(const query of [valid+'&error=access_denied',valid+'&error_description=denied',valid+'&state='+state,valid+'&corp_id=dingOther',`state=${state}&corp_id=dingCompanyFixture&admin_consent=True`,valid.replace(state,'short'),valid+'&auth_code=wecom'])assert.equal(values.dingtalkConsentRedirect(new URLSearchParams(query)),null);
});
test('DingTalk selection requires immutable explicit members without all-users or department expansion',()=>{
  const selection={spaceId:'original',corpId:'dingCompanyFixture',appId:34576,agentId:987654,members:['MemberCase','membercase']};
  assert.equal(values.dingtalkSelection(selection),true);
  for(const extra of [{members:[]},{members:['@ALL']},{members:['same','same']},{appId:0},{corpId:'wecom'},{members:Array(21).fill('m')}])assert.equal(values.dingtalkSelection({...selection,...extra}),false);
});
