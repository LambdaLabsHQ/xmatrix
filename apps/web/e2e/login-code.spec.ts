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

/** A Hub with no session until `state.signedIn` is set. */
async function hubSessionOnceSignedIn(page: import("@playwright/test").Page, state: { signedIn: boolean }) {
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: state.signedIn
    ? { user: { id: "user-1", email: "reviewer@example.test" }, session: { token: "s", expiresAt: "2099-01-01T00:00:00.000Z" } }
    : null }));
  await page.route("**/api/auth/token", route => state.signedIn
    ? route.fulfill({ json: { token: "fixture-jwt" } })
    : route.fulfill({ status: 401, json: {} }));
}

/** A Hub whose session appears once `signedIn` is set, and whose code check answers per call. */
async function codeCheck(page: import("@playwright/test").Page, answer: (call: number, state: { signedIn: boolean }) => "drop" | "ok" | "invalid" | "lost") {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true; });
  const state = { signedIn: false };
  let calls = 0;
  await page.route("**/api/xmatrix/login", route => route.fulfill({ json: { ok: true } }));
  await hubSessionOnceSignedIn(page, state);
  await page.route("**/api/auth/sign-in/email-otp", route => {
    calls += 1;
    const kind = answer(calls, state);
    if (kind === "drop") return route.abort("connectionreset");
    if (kind === "lost") { state.signedIn = true; return route.abort("connectionreset"); }
    if (kind === "invalid") return route.fulfill({ status: 401, json: { code: "INVALID_OTP", message: "Invalid OTP" } });
    state.signedIn = true;
    return route.fulfill({ json: { token: "s", user: { id: "user-1" } } });
  });
  await page.goto("/login");
  await page.getByLabel("Email address").fill("reviewer@example.test");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.getByLabel("Login code").fill("123456");
  return { calls: () => calls, state };
}

test("a code check that gets no answer is sent again and signs in", async ({ page }) => {
  const check = await codeCheck(page, call => call === 1 ? "drop" : "ok");
  await expect.poll(() => check.state.signedIn).toBe(true);
  expect(check.calls()).toBe(2);
  await expect(page.locator(".auth-error")).toHaveCount(0);
});

test("a sign-in whose reply was lost still completes when the spent code is refused", async ({ page }) => {
  const check = await codeCheck(page, call => call === 1 ? "lost" : "invalid");
  await expect.poll(() => check.calls()).toBe(2);
  await expect(page.getByText("That code didn't match.", { exact: false })).toHaveCount(0);
  await page.waitForURL(/\/app/u);
});

test("three unanswered code checks keep the code and offer to try again", async ({ page }) => {
  const check = await codeCheck(page, () => "drop");
  await expect(page.getByText("Couldn't reach xMatrix. Your code still works", { exact: false })).toBeVisible();
  expect(check.calls()).toBe(3);
  await expect(page.getByLabel("Login code")).toHaveValue("123456");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => check.calls()).toBe(6);
});

test("an app's sign-in that stopped for the second factor goes back to the Hub, not into the web", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true; });
  const state = { signedIn: false };
  await hubSessionOnceSignedIn(page, state);
  await page.route("**/api/auth/two-factor/verify-totp", route => {
    state.signedIn = true;
    return route.fulfill({ json: { token: "s", user: { id: "user-1" } } });
  });
  // The Hub's answer is left out: the page must leave only for it, with nothing else overtaking it.
  const finishes: string[] = [];
  await page.route("https://xmatrix-hub.xmatrix.sh/api/auth/app/finish**", route => {
    finishes.push(route.request().url());
    return route.abort();
  });
  const pages: string[] = [];
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) pages.push(new URL(frame.url()).pathname); });

  const finish = "https://xmatrix-hub.xmatrix.sh/api/auth/app/finish?flow=f";
  await page.goto(`/login?two_factor=1&continue=${encodeURIComponent(finish)}`);
  await page.getByLabel("Authentication code").fill("123456");

  await expect.poll(() => finishes).toEqual([finish]);
  await page.waitForTimeout(1_500);
  expect(pages).not.toContain("/app");
});
