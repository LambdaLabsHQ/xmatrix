import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, installWorkspaceStubs } from "./workspace-fixtures";
import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const NOW = "2026-09-27T12:00:00.000Z";
const summary = { pageId: "p-rules", parentPageId: null, title: "Governance", position: "V", accessMode: "open",
  headRevision: 1, agentSuggestOnly: false, canEdit: true, governance: false, updatedAt: NOW, publishedAt: null };

// Open-project governance: the owner opens the project from Team, names the
// page that states its rules from that page's Share; what participants start
// shows up as intake.
test("an owner opens the project, names its governance page, and sees what participants started as intake", async ({ page }) => {
  const question = { ...E2E_CHANNEL, id: "c-question", name: "How do I build on Windows?",
    metadata: { intakeOf: "participant-1" } };
  const team = { ...E2E_SPACE, id: "space-team", name: "Lambda Labs" };
  await installWorkspaceStubs(page, { spaces: [team], channels: [{ ...E2E_CHANNEL, spaceId: team.id },
    { ...question, spaceId: team.id }] });
  await fixtureJson(page, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, { pages: [summary] });
  await fixtureJson(page, "governance", /\/api\/xmatrix\/spaces\/[^/]+\/governance$/u,
    { openParticipation: false, governancePageId: null });
  await fixtureJson(page, "governance-set", /\/api\/xmatrix\/spaces\/[^/]+\/governance$/u,
    { openParticipation: true, governancePageId: null }, { method: "PUT" });

  await page.goto("/app/space-team", { waitUntil: "domcontentloaded" });
  const intake = page.getByTestId("intake-list");
  await expect(intake).toContainText("How do I build on Windows?");

  // Who may join is the Space's call: it sits with its members.
  await page.goto("/app/space-team/team", { waitUntil: "domcontentloaded" });
  const open = page.getByLabel("Anyone with a linked GitHub account can join as a participant");
  await open.click();
  await expect.poll(() => fixtureRequestBodies(page, "governance-set")).toEqual([{ openParticipation: true }]);
  await expect(open).toBeChecked();

  // The rules page is one page's edit permission: it sits in that page's Share.
  await fixtureJson(page, "governance-set-page", /\/api\/xmatrix\/spaces\/[^/]+\/governance$/u,
    { openParticipation: true, governancePageId: "p-rules" }, { method: "PUT" });
  await page.goto("/app/space-team/pages?page=p-rules", { waitUntil: "domcontentloaded" });
  await page.getByTestId("pages-view").getByRole("button", { name: "Share" }).click();
  await fixtureJson(page, "page-tree-rules", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u,
    { pages: [{ ...summary, governance: true }] });
  await page.getByLabel("Space rules: only owners and admins edit this page").click();
  await expect.poll(() => fixtureRequestBodies(page, "governance-set-page")).toEqual([{ governancePageId: "p-rules" }]);
  await expect(page.getByLabel("Space rules: only owners and admins edit this page")).toBeChecked();
});

test("a person joins an open project as a participant, once their GitHub account is linked", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "participate-unlinked", /\/governance\/participation$/u,
    { error: "Link your GitHub account in your profile to join an open project", code: "github_account_required" },
    { method: "POST", status: 403 });
  await page.goto("/spaces/join/space-open", { waitUntil: "domcontentloaded" });
  const join = page.getByTestId("space-join");
  await join.getByRole("button", { name: "Join" }).click();
  await expect(join.getByRole("alert")).toContainText("Link your GitHub account");
  await expect(join.getByRole("link", { name: "Open your profile" })).toBeVisible();

  await fixtureJson(page, "participate", /\/governance\/participation$/u, { role: "participant" }, { method: "POST" });
  await join.getByRole("button", { name: "Join" }).click();
  await expect(page).toHaveURL(/\/app\/space-open/u);
});
