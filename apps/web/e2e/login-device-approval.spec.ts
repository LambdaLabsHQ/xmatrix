import { expect, test } from "./fixtures";
import { fixtureRequestBodies, fixtureRequests, fixtureRule, installWorkspaceStubs } from "./workspace-fixtures";

const DEVICE_LOGIN = "/login?device_code=device-code-e2e&user_code=WDJB-MJHT";

async function stubApproval(page: import("@playwright/test").Page) {
  await installWorkspaceStubs(page);
  await fixtureRule(page, {
    id: "device-approve", pattern: "**/api/xmatrix/cli/device/approve",
    responder: { kind: "static", json: { approved: true } },
  });
  await fixtureRule(page, {
    id: "device-describe", pattern: "**/api/xmatrix/cli/device/describe",
    responder: { kind: "static", json: {
      createdAt: new Date().toISOString(), hostname: "studio-mac", platform: "darwin", requestedFrom: "Berlin, DE" } },
  });
  await fixtureRule(page, {
    id: "device-decline", pattern: "**/api/xmatrix/cli/device/decline",
    responder: { kind: "static", json: { ok: true } },
  });
}

test("a signed-in visitor approves a CLI sign-in only by an explicit click", async ({ page }) => {
  await stubApproval(page);
  await page.goto(DEVICE_LOGIN, { waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("device-approval-code")).toHaveText("WDJB-MJHT");
  await expect(page.getByText(/Approve only if your .* shows this code/u)).toBeVisible();
  // Opening the link alone must not hand the session over.
  await page.waitForTimeout(1_500);
  expect(await fixtureRequests(page, "device-approve")).toHaveLength(0);

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(async () => (await fixtureRequests(page, "device-approve")).length).toBe(1);
  expect(await fixtureRequestBodies(page, "device-approve")).toEqual([
    expect.objectContaining({ deviceCode: "device-code-e2e", userCode: "WDJB-MJHT" }),
  ]);
  await expect(page.getByText("You can return to your terminal. The CLI session is ready.")).toBeVisible();
});

test("the request shows where it came from, and declining it ends it without approving", async ({ page }) => {
  await stubApproval(page);
  await page.goto(DEVICE_LOGIN, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/near Berlin, DE · studio-mac \(darwin\)/u)).toBeVisible();
  await page.getByRole("button", { name: "This is not my request" }).click();
  await expect(page.getByText("Sign-in declined")).toBeVisible();
  expect(await fixtureRequestBodies(page, "device-decline")).toEqual([
    expect.objectContaining({ deviceCode: "device-code-e2e", userCode: "WDJB-MJHT" }),
  ]);
  expect(await fixtureRequests(page, "device-approve")).toHaveLength(0);
});
