import {expect,test,type Page} from './fixtures';
const state='a'.repeat(64),callback=`/connect/dingtalk?authCode=one_use_fixture_code&state=${state}`;
async function stubs(page:Page,prepareStatus=200,installStatus=503) {
  const prepared:unknown[]=[],confirmed:unknown[]=[];
  await page.route('**/api/xmatrix/connectors/dingtalk/install/prepare',route=>{
    prepared.push(route.request().postDataJSON());return route.fulfill({status:prepareStatus,json:prepareStatus===200?
      {spaceId:'original',corpId:'dingCompanyFixture',appId:34576,agentId:987654,members:['MemberCase','membercase']}:{error:'private-provider-error'}});
  });
  await page.route('**/api/xmatrix/spaces/*/app-connections/dingtalk/install',route=>{
    confirmed.push({url:route.request().url(),body:route.request().postDataJSON()});return route.fulfill({status:installStatus,json:installStatus===200?{ok:true}:{error:'private-check-error'}});
  });
  return {prepared,confirmed};
}
test('DingTalk consent strips callback, waits for Human and confirms only the original selected members/Space',async({page})=>{
  const calls=await stubs(page),response=await page.goto(callback);
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');expect(response?.headers()['cache-control']).toContain('no-store');
  await expect(page).toHaveURL(/\/connect\/dingtalk$/u);expect(calls.prepared).toHaveLength(0);
  await page.getByRole('button',{name:'Verify company'}).click();await expect(page.getByText('dingCompanyFixture',{exact:true})).toBeVisible();
  expect(calls.prepared).toEqual([{state,authCode:'one_use_fixture_code'}]);expect(calls.confirmed).toHaveLength(0);
  await expect(page.getByRole('checkbox')).toHaveCount(1);const confirm=page.getByRole('button',{name:'Confirm installation'});await expect(confirm).toBeDisabled();
  await page.getByRole('checkbox',{name:/I confirm this company/u}).check();await confirm.click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('fresh authorization');
  expect(calls.confirmed).toEqual([{url:expect.stringContaining('/spaces/original/app-connections/dingtalk/install'),body:{state,confirmed:true}}]);
  await expect(page.getByRole('button',{name:'Verify company'})).toBeDisabled();
  expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain(state);
  await expect(page.locator('body')).not.toContainText('private-check-error');
});
test('DingTalk errors/duplicate consent never exchange even when native admin_consent is True',async({page})=>{
  const calls=await stubs(page);
  for(const url of [callback+'&error=access_denied',callback+'&state='+state,`/connect/dingtalk?state=${state}&corp_id=dingCompanyFixture&admin_consent=True`]) {
    await page.goto(url);await expect(page).toHaveURL(/\/connect\/dingtalk$/u);
    await expect(page.getByRole('main').getByRole('alert')).toContainText('denied or invalid');await expect(page.getByRole('button',{name:'Verify company'})).toBeDisabled();
  }expect(calls.prepared).toHaveLength(0);
});
test('DingTalk uncertain verification is spent without automatic retries',async({page})=>{
  const calls=await stubs(page,503);await page.goto(callback);await page.getByRole('button',{name:'Verify company'}).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Start again');await expect(page.getByRole('button',{name:'Verify company'})).toBeDisabled();expect(calls.prepared).toHaveLength(1);
});
test('DingTalk successful confirmation returns to the original Apps detail once',async({page})=>{
  const calls=await stubs(page,200,200);
  await page.route('**/app/original/apps?connector=dingtalk&oauth=connected',route=>route.fulfill({contentType:'text/html',body:'<main>Connected</main>'}));
  await page.goto(callback);await page.getByRole('button',{name:'Verify company'}).click();
  await page.getByRole('checkbox',{name:/I confirm this company/u}).check();await page.getByRole('button',{name:'Confirm installation'}).click();
  await expect(page).toHaveURL(/\/app\/original\/apps\?connector=dingtalk&oauth=connected$/u);
  expect(calls.prepared).toHaveLength(1);expect(calls.confirmed).toHaveLength(1);
});
