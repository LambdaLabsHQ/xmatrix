import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW, fixtureJson, fixtureRequestBodies,
  fixtureRequests, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const connection = {
  id: `${E2E_SPACE.id}:github`, spaceId: E2E_SPACE.id, providerId: "github", providerName: "GitHub",
  status: "configured", error: null, version: 3, authMode: "oauth", scopes: ["metadata:read", "issues:read"],
  secretRefs: [], capabilities: ["github.metadata.read", "github.issues.read"], channelIds: [],
  metadata: { installationIds: ["111"] }, credentialFields: [], createdBy: "e2e-user",
  createdAt: E2E_NOW, updatedAt: E2E_NOW, lastCheckedAt: E2E_NOW,
};
const installations = /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/github\/installations(?:\?.*)?$/;

async function openGitHub(page: Page, { status = "configured", grant }: { status?: string; grant?: string } = {}) {
  if (grant) {
    // As the return from GitHub's authorization leaves it for this tab.
    await page.addInitScript((value) => window.sessionStorage.setItem("xmatrix:github-grant", value), grant);
  }
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "github-providers", "**/api/xmatrix/connectors/oauth/providers", { providers: ["github"] });
  await fixtureJson(page, "github-connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, {
    connections: [{ ...connection, status }],
  });
  await fixtureJson(page, "github-executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await fixtureJson(page, "github-policies", /\/app-connections\/github\/policies$/, { policies: [] });
  await fixtureJson(page, "github-installations", installations, {
    linked: status === "disconnected" ? []
      : [{ installationId: "111", login: "LambdaLabsHQ", type: "Organization", repositorySelection: "selected" }],
    available: grant ? [{ installationId: "222", login: "yiming", type: "User", repositorySelection: "all" }] : [],
    authorized: Boolean(grant),
  }, { method: "GET" });
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: "GitHub" }).click();
}

test("GitHub lists every linked account and offers to find the person's other accounts on GitHub", async ({ page }) => {
  await openGitHub(page);
  const accounts = page.getByTestId("github-installation-accounts");
  await expect(accounts.getByTestId("github-installation-account")).toHaveCount(1);
  await expect(accounts).toContainText("LambdaLabsHQ");
  await expect(accounts.getByRole("button", { name: "Unlink LambdaLabsHQ" })).toBeVisible();
  await expect(accounts.getByRole("button", { name: "Find my GitHub accounts" })).toBeVisible();
  // Without an authorization from GitHub, the list asks with no grant.
  for (const url of await fixtureRequests(page, "github-installations")) expect(url).not.toContain("grant=");
});

test("after authorizing on GitHub the person links an account with their grant", async ({ page }) => {
  await openGitHub(page, { grant: "grant-1" });
  const accounts = page.getByTestId("github-installation-accounts");
  await expect(accounts).toContainText("Your GitHub accounts, not linked here");
  await expect(accounts.getByRole("button", { name: "Find my GitHub accounts" })).toHaveCount(0);
  expect((await fixtureRequests(page, "github-installations"))[0]).toMatch(/\?grant=grant-1$/u);

  await fixtureJson(page, "github-link", installations, { connection: {
    ...connection, version: 4, metadata: { installationIds: ["111", "222"] },
  } }, { method: "POST" });
  await accounts.getByRole("button", { name: "Link yiming" }).click();
  await expect.poll(async () => (await fixtureRequests(page, "github-link")).length).toBe(1);
  expect(await fixtureRequestBodies(page, "github-link")).toEqual([{ installationId: "222", grant: "grant-1" }]);
});

test("a disconnected GitHub still shows its accounts section", async ({ page }) => {
  await openGitHub(page, { status: "disconnected", grant: "grant-1" });
  const accounts = page.getByTestId("github-installation-accounts");
  await expect(accounts).toContainText("No GitHub account is linked to this Space.");
  await expect(accounts.getByRole("button", { name: "Link yiming" })).toBeVisible();
});
