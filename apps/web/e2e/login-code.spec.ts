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

async function recordAppFinishes(page: import("@playwright/test").Page) {
  const finishes: string[] = [];
  await page.route("https://xmatrix-hub.xmatrix.sh/api/auth/app/finish**", route => {
    finishes.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "App finish" });
  });
  return finishes;
}

// The prior happy path began signed out. It could not catch a remembered
// website session completing an app handoff before this visit verifies a code.
for (const { remembered, backup } of [
  { remembered: false, backup: false },
  { remembered: true, backup: false },
  { remembered: true, backup: true },
]) {
  test(`an app handoff waits for this visit's ${backup ? "backup" : "authenticator"} code (remembered session: ${remembered})`, async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true; });
    const state = { signedIn: remembered };
    await hubSessionOnceSignedIn(page, state);
    let verifies = 0;
    await page.route(`**/api/auth/two-factor/verify-${backup ? "backup-code" : "totp"}`, route => {
      verifies += 1;
      if (verifies === 1) return route.fulfill({ status: 401, json: { code: "INVALID_CODE", message: "Invalid code" } });
      state.signedIn = true;
      return route.fulfill({ json: { token: "s", user: { id: "user-1" } } });
    });
    const finishes = await recordAppFinishes(page);
    const pages: string[] = [];
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) pages.push(new URL(frame.url()).pathname); });

    const finish = "https://xmatrix-hub.xmatrix.sh/api/auth/app/finish?flow=f";
    await page.goto(`/login?two_factor=1&continue=${encodeURIComponent(finish)}`);
    if (backup) await page.getByRole("button", { name: "Use a backup code" }).click();
    const input = page.getByLabel(backup ? "Backup code" : "Authentication code", { exact: true });
    await input.fill(backup ? "invalid-backup" : "000000");
    if (backup) await page.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(page.getByText("That code didn't match.", { exact: false })).toBeVisible();
    expect(finishes).toEqual([]);
    await expect(input).toHaveValue("");
    await input.fill(backup ? "valid-backup" : "123456");
    if (backup) await page.getByRole("button", { name: "Verify", exact: true }).click();
    await expect.poll(() => finishes).toEqual([finish]);
    expect(verifies).toBe(2);
    expect(pages).not.toContain("/app");
  });
}

test("starting a two-factor visit over signs out before showing another sign-in", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true; });
  const state = { signedIn: true };
  await hubSessionOnceSignedIn(page, state);
  let signOuts = 0;
  await page.route("**/api/auth/sign-out", route => {
    signOuts += 1;
    state.signedIn = false;
    return route.fulfill({ json: { success: true } });
  });
  const finishes = await recordAppFinishes(page);
  const finish = "https://xmatrix-hub.xmatrix.sh/api/auth/app/finish?flow=restart";
  await page.goto(`/login?two_factor=1&continue=${encodeURIComponent(finish)}`);
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  expect(signOuts).toBe(1);
  expect(finishes).toEqual([]);
  expect(new URL(page.url()).searchParams.get("continue")).toBeNull();
});
