import { expect, test } from "./fixtures";
import { installWorkspaceStubs } from "./workspace-fixtures";

/* A desktop app signed in with its own session: the page reads only the access
   token, and its account calls (here, signing out) go through the web route
   that adds the session from its HTTP-only cookie. */
test("a native app's account calls go through its own session route, with no session token on the page", async ({ page }) => {
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
  const sessionRequests: string[] = [];
  await page.route("**/api/xmatrix/native-session", async route => {
    sessionRequests.push(route.request().method());
    await route.fulfill({ json: route.request().method() === "GET" ? { session: {
      token: "native-access-token", authProvider: "better-auth",
      // No chosen name yet, so the app opens on the name step and its "Use a different account".
      user: { id: "native-user", email: "native@xmatrix.test", name: "" },
      hubUrl: "https://xmatrix-hub.test", relayUrl: "wss://xmatrix-hub.test",
    } } : { ok: true } });
  });
  const accountCalls: { path: string; authorization?: string }[] = [];
  await page.route("**/api/xmatrix/native-auth/**", async route => {
    accountCalls.push({ path: new URL(route.request().url()).pathname, authorization: route.request().headers().authorization });
    await route.fulfill({ json: { success: true } });
  });
  const hubAuthCalls: string[] = [];
  await page.route("**/api/auth/**", async route => {
    hubAuthCalls.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: null });
  });

  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Use a different account" }).click();
  await expect.poll(() => accountCalls.map(({ path }) => path)).toContain("/api/xmatrix/native-auth/sign-out");
  expect(accountCalls.every(({ authorization }) => authorization === undefined)).toBe(true);
  await expect.poll(() => sessionRequests).toContain("DELETE");
  expect(hubAuthCalls.filter(path => path.endsWith("/sign-out"))).toEqual([]);
});
