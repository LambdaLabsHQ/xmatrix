import { expect, test } from "./fixtures";

test("account deletion requires all confirmations and retries an uncertain delivery with the same receipt", async ({ page }) => {
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/xmatrix/account-deletion", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { blockers: [] } });
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    return route.fulfill({ status: 202, json: { state: "preparing" } });
  });
  await page.route("**/api/xmatrix/account-deletion/status", route => route.fulfill({ status: 404, json: { error: "Not found" } }));
  await page.goto("/account/delete");
  const submit = page.getByRole("button", { name: "Permanently delete account" });
  await expect(submit).toBeDisabled();
  await page.getByLabel("Account email", { exact: true }).fill("e2e@xmatrix.test");
  await page.getByLabel("Type DELETE", { exact: true }).fill("DELETE");
  await expect(submit).toBeDisabled();
  await page.getByRole("checkbox").check();
  await submit.click();
  await page.getByRole("button", { name: "Retry same deletion request" }).click();
  await expect(page.getByRole("button", { name: "Cancel deletion request" })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].acknowledge).toBe(true);
});

test("an owned Space blocks deletion and an ordinary membership requires explicit leave confirmation", async ({ page }) => {
  let left = false;
  await page.route("**/api/xmatrix/account-deletion", route => route.fulfill({ json: { blockers: [
    { kind: "owned_space", spaceId: "owned", name: "My team" },
    ...left ? [] : [{ kind: "membership", spaceId: "joined", name: "Another team" }],
  ] } }));
  await page.route("**/api/xmatrix/account-deletion/leave-space", route => {
    expect(route.request().postDataJSON()).toEqual({ spaceId: "joined" });
    left = true;
    return route.fulfill({ json: { left: true } });
  });
  await page.goto("/account/delete");
  await expect(page.getByRole("button", { name: "Permanently delete account" })).toHaveCount(0);
  await page.getByRole("button", { name: "Leave Space", exact: true }).click();
  expect(left).toBe(false);
  await page.getByRole("button", { name: "Confirm leave" }).click();
  await expect(page.getByText("Another team", { exact: true })).toHaveCount(0);
  await expect(page.getByText("My team", { exact: true })).toBeVisible();
});
