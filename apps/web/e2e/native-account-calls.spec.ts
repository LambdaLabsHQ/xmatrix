import { expect, test } from "./fixtures";
import { fixtureRequestRecords } from "./in-page-api-fixtures";
import { fixtureRule, installWorkspaceStubs } from "./workspace-fixtures";

/* A desktop app signed in with its own session: the page reads only the access
   token, and its account calls (here, signing out) go through the web route
   that adds the session from its HTTP-only cookie, never to the Hub directly. */
test("a native app's account calls go through its own session route, not to the Hub with a token", async ({ page }) => {
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
  await fixtureRule(page, {
    id: "native-session", pattern: "**/api/xmatrix/native-session", method: "GET",
    responder: { kind: "static", json: { session: {
      token: "native-access-token", authProvider: "better-auth",
      // No chosen name yet, so the app opens on the name step and its "Use a different account".
      user: { id: "native-user", email: "native@xmatrix.test", name: "" },
      hubUrl: "https://xmatrix-hub.test", relayUrl: "wss://xmatrix-hub.test",
    } } },
  });
  await fixtureRule(page, {
    id: "native-session-end", pattern: "**/api/xmatrix/native-session", method: "DELETE",
    responder: { kind: "static", json: { ok: true } },
  });
  await fixtureRule(page, {
    id: "native-auth", pattern: "**/api/xmatrix/native-auth/**",
    responder: { kind: "static", json: { success: true } },
  });
  const hubAuthCalls: string[] = [];
  await page.route("**/api/auth/**", async route => {
    hubAuthCalls.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: null });
  });

  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Use a different account" }).click();
  await expect.poll(async () => (await fixtureRequestRecords(page, "native-auth"))
    .map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toContain("POST /api/xmatrix/native-auth/sign-out");
  await expect.poll(async () => (await fixtureRequestRecords(page, "native-session-end")).length).toBe(1);
  expect(hubAuthCalls.filter(path => path.endsWith("/sign-out"))).toEqual([]);
});
