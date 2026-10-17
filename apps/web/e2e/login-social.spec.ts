import { expect, test } from "./fixtures";

// The browser owns provider selection and the return context. Hub callback
// security is exercised separately against the actual PostgreSQL auth handler.
for (const provider of ["GitHub", "Google"]) {
  for (const context of [
    { query: "?next=%2Fapp%3Fview%3Dpages", returnPath: "/app?view=pages" },
    { query: "?device_code=device-fixture&user_code=ABCD-EFGH&client=cli", returnPath: "/login?device_code=device-fixture&user_code=ABCD-EFGH&client=cli" },
  ]) {
    test(`${provider} sign-in preserves ${context.returnPath}`, async ({ page }) => {
      await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true; });
      await page.route("**/api/auth/get-session", route => route.fulfill({ json: null }));
      const requests: Record<string, unknown>[] = [];
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      await page.route("**/api/auth/sign-in/social", async route => {
        requests.push(route.request().postDataJSON());
        await pending;
        await route.fulfill({ status: 400, json: { message: "Provider temporarily unavailable" } });
      });
      await page.goto(`/login${context.query}`);
      await page.getByRole("button", { name: `Continue with ${provider}` }).click();
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]).toMatchObject({
        provider: provider.toLowerCase(), callbackURL: new URL(context.returnPath, page.url()).href,
        errorCallbackURL: new URL("/login", page.url()).href,
      });
      await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Continue with email" })).toBeDisabled();
      finish();
      await expect(page.getByText("Provider temporarily unavailable")).toBeVisible();
      await expect(page.getByRole("button", { name: `Continue with ${provider}` })).toBeEnabled();
    });
  }
}

test("a refused GitHub callback offers a fresh sign-in and email recovery", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true; });
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: null }));
  await page.goto("/login?error=access_denied");
  await expect(page.getByText("Sign-in did not complete. Try again, or use a login code.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeEnabled();
});
