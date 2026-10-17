import { expect, test } from "./fixtures";
import { installWorkspaceStubs } from "./workspace-fixtures";

/* A desktop app signed in with its own session: the page reads only the access
   token, and its account calls go through the web route that adds the session. */
test("a native app's account calls go through its own session route, with no refresh token on the page", async ({ page }) => {
  await installWorkspaceStubs(page);
  await page.addInitScript(() => {
    const shell = window as unknown as Record<string, unknown>;
    shell.__xmatrixDisableMockAuth = true;
    shell.xmatrixDesktop = {
      client: "desktop", platform: "darwin",
      getContext: async () => ({ client: "desktop", platform: "darwin", version: "1.0.560" }),
      setBadge: async () => undefined, setTitle: async () => undefined, notify: async () => true,
      openExternal: async () => undefined, checkCliInstalled: async () => ({ installed: true }),
    };
  });
  await page.route("**/api/xmatrix/native-session", route => route.fulfill({ json: { session: {
    token: process.env.NEXT_PUBLIC_XMATRIX_MOCK_AUTH_TOKEN ?? "e2e-mock-token", authProvider: "better-auth",
    user: { id: "e2e-user", email: "e2e@xmatrix.test", name: "E2E User" },
    hubUrl: "https://xmatrix-hub.test", relayUrl: "wss://xmatrix-hub.test",
  } } }));
  const accountCalls: string[] = [];
  await page.route("**/api/xmatrix/native-auth/**", async route => {
    accountCalls.push(new URL(route.request().url()).pathname);
    expect(route.request().headers().authorization).toBeUndefined();
    await route.fulfill({ json: { user: { id: "e2e-user", email: "e2e@xmatrix.test", twoFactorEnabled: false } } });
  });
  const hubAuthCalls: string[] = [];
  await page.route("**/api/auth/**", async route => {
    hubAuthCalls.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: null });
  });

  await page.goto("/app?view=profile", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("two-factor-settings")).toBeVisible();
  await expect.poll(() => accountCalls).toContain("/api/xmatrix/native-auth/get-session");
  expect(hubAuthCalls.filter(path => path.endsWith("/get-session"))).toEqual([]);
});
