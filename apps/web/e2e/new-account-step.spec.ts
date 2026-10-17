import { expect, test } from "./fixtures";
import { installWorkspaceStubs } from "./workspace-fixtures";

test("a sign-in that made a new account says so once, before the app opens", async ({ page }) => {
  await installWorkspaceStubs(page);
  await page.goto("/app?new_account=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Your new xMatrix account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use a different account" })).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Your new xMatrix account" })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("new_account")).toBe(false);
});
