import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

type AuthorizeRequest = { url: string; redirectParam: string };

/**
 * A phone app that can open the provider's page in place: the shell's sheet is
 * stubbed to answer the address the Hub would send it back to.
 */
async function openAsPhoneApp(page: Page, options: { inPlace: boolean; answerState?: "same" | "other"; client?: "ios" | "desktop" }) {
  await page.addInitScript(({ inPlace, answerState, client = "ios" }) => {
    const shell = window as unknown as Record<string, unknown>;
    shell.__xmatrixDisableMockAuth = true;
    shell.__authorizeRequests = [];
    shell.xmatrixDesktop = {
      client, platform: client === "ios" ? "ios" : "darwin",
      getContext: async () => ({ client, platform: client === "ios" ? "ios" : "darwin", version: "1.0.600" }),
      setBadge: async () => undefined, setTitle: async () => undefined,
      notify: async () => true, openExternal: async () => undefined,
      checkCliInstalled: async () => ({ installed: false }),
      ...(inPlace ? {
        authorizeInBrowser: async (request: AuthorizeRequest) => {
          (shell.__authorizeRequests as AuthorizeRequest[]).push(request);
          const state = answerState === "same" ? new URL(request.url).searchParams.get("state") : "someone-elses-state";
          return `xmatrix://auth?code=${"c".repeat(64)}&state=${state}`;
        },
      } : {}),
    };
  }, options);
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: null }));
  await page.route("**/api/xmatrix/native-session", route => route.request().method() === "GET"
    ? route.fulfill({ json: { session: null } })
    : route.fulfill({ json: { session: route.request().postDataJSON() } }));
}

/** The token route, answering every redemption with `signedIn`; returns the bodies it was sent. */
async function stubRedemption(page: Page): Promise<Record<string, string>[]> {
  const redeemed: Record<string, string>[] = [];
  await page.route("**/api/xmatrix/app-sign-in/token", async route => {
    redeemed.push(route.request().postDataJSON());
    await route.fulfill({ json: signedIn });
  });
  return redeemed;
}

const signedIn = {
  token: "app-access-token", refreshToken: "app-refresh-token", authProvider: "better-auth",
  user: { id: "app-user", email: "app@example.test", name: "App User" },
  hubUrl: "https://xmatrix-hub.test", relayUrl: "wss://xmatrix-hub.test",
};

test("an app signs in with Google in place, redeeming the code with the verifier behind its challenge", async ({ page }) => {
  await openAsPhoneApp(page, { inPlace: true, answerState: "same" });
  const redeemed = await stubRedemption(page);
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in with browser" })).toHaveCount(0);
  await expect(page.getByLabel("Email address")).toBeVisible();

  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.waitForURL(/\/app/u);

  const [request] = await page.evaluate(() => (window as unknown as { __authorizeRequests: AuthorizeRequest[] }).__authorizeRequests);
  const start = new URL(request.url);
  expect(start.pathname).toBe("/api/auth/app/start");
  expect(request.redirectParam).toBe("redirect_uri");
  expect(start.searchParams.get("provider")).toBe("google");
  expect(start.searchParams.get("code_challenge_method")).toBe("S256");
  expect(redeemed).toHaveLength(1);
  expect(redeemed[0].code).toBe("c".repeat(64));
  // Only the page that started the sign-in holds the verifier its challenge was made from.
  expect(createHash("sha256").update(redeemed[0].codeVerifier).digest("base64url"))
    .toBe(start.searchParams.get("code_challenge"));
});

test("an answer carrying another sign-in's state is refused before any code is redeemed", async ({ page }) => {
  await openAsPhoneApp(page, { inPlace: true, answerState: "other" });
  const redeemed = await stubRedemption(page);
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect(page.getByText("That sign-in answer wasn't for this app. Start the sign-in again.")).toBeVisible();
  expect(redeemed).toHaveLength(0);
});

test("an app without in-place sign-in keeps signing in through the browser", async ({ page }) => {
  await openAsPhoneApp(page, { inPlace: false });
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in with browser" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
});

test("a desktop app signs in by a signed-in phone scanning its code, and remembers how this app last signed in", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("xmatrix.lastSignInMethod", "github"));
  await openAsPhoneApp(page, { inPlace: true, answerState: "same", client: "desktop" });
  await page.route("**/api/xmatrix/cli/device/start", route => route.fulfill({ json: {
    deviceCode: "device-code-phone", userCode: "PHON-E123", expiresIn: 600, interval: 5,
    verificationUri: "https://xmatrix.sh/login",
    verificationUriComplete: "https://xmatrix.sh/login?device_code=device-code-phone&user_code=PHON-E123",
  } }));
  await page.route("**/api/xmatrix/cli/device/token", route => route.fulfill({ json: { status: "pending", interval: 5 } }));
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /Continue with GitHub\s*Last used/u })).toBeVisible();

  await page.getByRole("button", { name: "Sign in with your phone" }).click();
  await expect(page.getByRole("img", { name: "Sign-in code to scan with your phone" })).toBeVisible();
  await page.getByRole("button", { name: "Use another way" }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});
