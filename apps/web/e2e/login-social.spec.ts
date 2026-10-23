import { expect, test } from "./fixtures";

// The browser owns provider selection and the return context. Hub callback
// security is exercised separately against the actual PostgreSQL auth handler.
for (const provider of ["GitHub", "Google"]) {
  // A failed sign-in comes back to the page it started on, minus the provider's own callback leftovers.
  for (const context of [
    { query: "?next=%2Fapp%3Fview%3Dpages", returnPath: "/app?view=pages", errorPath: "/login?next=%2Fapp%3Fview%3Dpages",
      newUserPath: "/app?view=pages&new_account=1" },
    { query: `?next=${encodeURIComponent("/oauth/authorize?client_id=external-ai&state=external-state&scope=xmatrix%3Aread")}`,
      returnPath: "/oauth/authorize?client_id=external-ai&state=external-state&scope=xmatrix%3Aread",
      errorPath: `/login?next=${encodeURIComponent("/oauth/authorize?client_id=external-ai&state=external-state&scope=xmatrix%3Aread")}`,
      // An outside app's signed authorization query is never added to.
      newUserPath: "/oauth/authorize?client_id=external-ai&state=external-state&scope=xmatrix%3Aread" },
    { query: "?next=https%3A%2F%2Funtrusted.example%2Fcallback", returnPath: "/app",
      errorPath: "/login?next=https%3A%2F%2Funtrusted.example%2Fcallback", newUserPath: "/app?new_account=1" },
    { query: "?device_code=device-fixture&user_code=ABCD-EFGH&client=cli&state=stale-provider-state&code=stale-code",
      returnPath: "/login?device_code=device-fixture&user_code=ABCD-EFGH&client=cli",
      errorPath: "/login?device_code=device-fixture&user_code=ABCD-EFGH&client=cli",
      newUserPath: "/login?device_code=device-fixture&user_code=ABCD-EFGH&client=cli" },
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
        errorCallbackURL: new URL(context.errorPath, page.url()).href,
        newUserCallbackURL: new URL(context.newUserPath, page.url()).href,
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

test("a refused GitHub callback says why and offers a fresh sign-in and email recovery", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true; });
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: null }));
  await page.goto("/login?error=access_denied");
  await expect(page.getByText("Sign-in was cancelled. Choose a way to sign in when you're ready.")).toBeVisible();
  await page.goto("/login?error=unable_to_get_user_info");
  await expect(page.getByText("Sign-in did not complete. Try again, or use a login code.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeEnabled();
});
