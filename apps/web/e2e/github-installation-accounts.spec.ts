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
const installations = /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/github\/installations$/;

async function openGitHub(page: Page, status = "configured") {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "github-providers", "**/api/xmatrix/connectors/oauth/providers", { providers: ["github"] });
  await fixtureJson(page, "github-connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, {
    connections: [{ ...connection, status }],
  });
  await fixtureJson(page, "github-executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await fixtureJson(page, "github-policies", /\/app-connections\/github\/policies$/, { policies: [] });
  await fixtureJson(page, "github-installations", installations, {
    linked: [{ installationId: "111", login: "LambdaLabsHQ", type: "Organization", repositorySelection: "selected" }],
    available: [{ installationId: "222", login: "yiming", type: "User", repositorySelection: "all" }],
    accountRequired: false,
  }, { method: "GET" });
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: "GitHub" }).click();
}

test("GitHub lists every linked account and links one already installed on GitHub", async ({ page }) => {
  await openGitHub(page);
  const accounts = page.getByTestId("github-installation-accounts");
  await expect(accounts.getByTestId("github-installation-account")).toHaveCount(2);
  await expect(accounts).toContainText("LambdaLabsHQ");
  await expect(accounts).toContainText("Installed on GitHub, not linked here");
  await expect(accounts.getByRole("button", { name: "Unlink LambdaLabsHQ" })).toBeVisible();

  await fixtureJson(page, "github-link", installations, { connection: {
    ...connection, version: 4, metadata: { installationIds: ["111", "222"] },
  } }, { method: "POST" });
  await accounts.getByRole("button", { name: "Link yiming" }).click();
  await expect.poll(async () => (await fixtureRequests(page, "github-link")).length).toBe(1);
  expect(await fixtureRequestBodies(page, "github-link")).toEqual([{ installationId: "222" }]);
});

test("a disconnected GitHub still offers its accounts to link", async ({ page }) => {
  await openGitHub(page, "disconnected");
  const accounts = page.getByTestId("github-installation-accounts");
  await expect(accounts.getByRole("button", { name: "Link yiming" })).toBeVisible();
});
