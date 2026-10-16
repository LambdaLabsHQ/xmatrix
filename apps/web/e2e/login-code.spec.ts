import { expect, test } from "./fixtures";

async function signedOut(page: import("@playwright/test").Page) {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true; });
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: null }));
}

test("a complete login code signs in once without a click, and a resend waits out its cooldown", async ({ page }) => {
  await signedOut(page);
  const sends: string[] = [];
  const verifies: unknown[] = [];
  await page.route("**/api/xmatrix/login", route => {
    sends.push(route.request().postDataJSON().email);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/auth/sign-in/email-otp", route => {
    verifies.push(route.request().postDataJSON());
    return route.fulfill({ status: 401, json: { code: "INVALID_OTP", message: "Invalid OTP" } });
  });

  await page.clock.install();
  await page.goto("/login");
  await page.getByLabel("Email address").fill("reviewer@example.test");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  const resend = page.getByRole("button", { name: /Resend code/u });
  await expect(resend).toBeDisabled();

  await page.getByLabel("Login code").fill("123456");
  await expect.poll(() => verifies.length).toBe(1);
  expect(verifies[0]).toMatchObject({ email: "reviewer@example.test", otp: "123456" });
  await expect(page.getByText("That code didn't match.", { exact: false })).toBeVisible();
  // A refused code is not retried on its own.
  await page.waitForTimeout(500);
  expect(verifies).toHaveLength(1);

  await page.clock.runFor(31_000);
  await expect(resend).toBeEnabled();
  await resend.click();
  await expect.poll(() => sends).toEqual(["reviewer@example.test", "reviewer@example.test"]);
  await expect(resend).toBeDisabled();
});
