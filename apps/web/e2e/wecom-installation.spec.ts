import { expect, test, type Page } from "./fixtures";
const state="a".repeat(64),code="c".repeat(64),callback=`/connect/wecom?auth_code=${code}&state=${state}&expires_in=600`;
async function stubs(page: Page, prepareStatus=200, installStatus=503) {
  const prepared: unknown[]=[],confirmed: unknown[]=[];
  await page.route("**/api/xmatrix/connectors/wecom/install/prepare",route=>{
    prepared.push(route.request().postDataJSON());return route.fulfill({status:prepareStatus,json:prepareStatus===200?
      {spaceId:"original",corpId:"wpCompany",agentId:1000001,visibleMembers:["memberone","membertwo"]}:{error:"private-provider-error"}});
  });
  await page.route("**/api/xmatrix/spaces/*/app-connections/wecom/install",route=>{
    confirmed.push({url:route.request().url(),body:route.request().postDataJSON()});return route.fulfill({status:installStatus,json:installStatus===200?{ok:true}:{error:"private-member-error"}});
  });
  return {prepared,confirmed};
}
test("WeCom strips its code, never auto-exchanges and confirms explicit members in only the original Space",async({page})=>{
  const calls=await stubs(page);const response=await page.goto(callback);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(page).toHaveURL(/\/connect\/wecom$/u);expect(calls.prepared).toHaveLength(0);
  await page.getByRole("button",{name:"Verify company"}).click();await expect(page.getByText("wpCompany",{exact:true})).toBeVisible();
  expect(calls.prepared).toEqual([{state,code}]);expect(calls.confirmed).toHaveLength(0);await expect(page.getByRole("combobox")).toHaveCount(0);
  const confirm=page.getByRole("button",{name:"Confirm installation"});await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox",{name:"memberone",exact:true}).check();await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox",{name:/I confirm this company/u}).check();await confirm.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("start a fresh installation");
  expect(calls.confirmed).toEqual([{url:expect.stringContaining("/spaces/original/app-connections/wecom/install"),body:{state,members:["memberone"],confirmed:true}}]);
  await expect(page.getByRole("button",{name:"Verify company"})).toBeDisabled();
  expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain(code);
  await expect(page.locator("body")).not.toContainText("private-member-error");
});
test("WeCom uncertain code exchange is never retried",async({page})=>{
  const calls=await stubs(page,503);await page.goto(callback);await page.getByRole("button",{name:"Verify company"}).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("start again");await expect(page.getByRole("button",{name:"Verify company"})).toBeDisabled();
  expect(calls.prepared).toHaveLength(1);expect(calls.confirmed).toHaveLength(0);await expect(page.locator("body")).not.toContainText("private-provider-error");
});
test("invalid and duplicate WeCom state or codes cannot enter company authorization",async({page})=>{
  const calls=await stubs(page);for(const query of [`auth_code=short&state=${state}`,`auth_code=${code}&state=${state}&state=${state}`]){
    await page.goto(`/connect/wecom?${query}`);await expect(page).toHaveURL(/\/connect\/wecom$/u);await expect(page.getByRole("main").getByRole("alert")).toContainText("missing or invalid");
    await expect(page.getByRole("button",{name:"Verify company"})).toBeDisabled();
  }expect(calls.prepared).toHaveLength(0);
});
test("successful WeCom installation returns to the original Apps detail once",async({page})=>{
  const calls=await stubs(page,200,200);await page.route("**/app/original/apps?connector=wecom&oauth=connected",route=>route.fulfill({contentType:"text/html",body:"<main>Connected</main>"}));
  await page.goto(callback);await page.getByRole("button",{name:"Verify company"}).click();await page.getByRole("checkbox",{name:"membertwo",exact:true}).check();
  await page.getByRole("checkbox",{name:/I confirm this company/u}).check();await page.getByRole("button",{name:"Confirm installation"}).click();
  await expect(page).toHaveURL(/\/app\/original\/apps\?connector=wecom&oauth=connected$/u);expect(calls.prepared).toHaveLength(1);expect(calls.confirmed).toHaveLength(1);
});
