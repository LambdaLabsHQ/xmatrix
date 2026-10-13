import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, fixtureRequestBodies, fixtureRequests, fixtureRule } from "./workspace-fixtures";
import { installApiFixtures } from "./in-page-api-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

async function openConsent(page: Page, { lookupStatus = 200, redirect = "https://untrusted.example/callback" } = {}) {
  await installApiFixtures(page);
  await fixtureRule(page, {
    id: "oauth-client", pattern: "**/api/auth/oauth2/public-client?*",
    responder: { kind: "static", status: lookupStatus, json: lookupStatus === 200
      ? { client_name: "ChatGPT" } : { error_description: "Couldn't read the app's request" } },
  });
  await fixtureRule(page, {
    id: "oauth-consent", pattern: "**/api/auth/oauth2/consent", method: "POST",
    responder: { kind: "static", status: 400, json: { error_description: "Fixture stops navigation" } },
  });
  const query = new URLSearchParams({ client_id: "unverified-client", redirect_uri: redirect,
    scope: "xmatrix:read xmatrix:write offline_access", sig: "signed-by-hub" });
  await page.goto(`/oauth/consent?${query}`);
}

test("consent identifies a self-declared app and its return host before explicit approval", async ({ page }) => {
  await openConsent(page);
  await expect(page.getByRole("heading", { name: "ChatGPT wants to use your xMatrix" })).toBeVisible();
  await expect(page.getByText("xMatrix has not verified its identity.", { exact: false })).toBeVisible();
  await expect(page.getByText("Only allow access if you started this connection from an app you trust.", { exact: false })).toBeVisible();
  await expect(page.getByText("untrusted.example", { exact: true })).toBeVisible();
  await expect(page.getByText("Edit pages and send messages as you", { exact: true })).toBeVisible();
  expect(await fixtureRequests(page, "oauth-consent")).toHaveLength(0);
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.locator("main [role=alert]")).toContainText("Fixture stops navigation");
  const requests = await fixtureRequestBodies(page, "oauth-consent");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ accept: true });
});

test("failed client lookup blocks approval while still allowing denial", async ({ page }) => {
  await openConsent(page, { lookupStatus: 503 });
  await expect(page.locator("main [role=alert]")).toContainText("Couldn't read the app's request");
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeDisabled();
  expect(await fixtureRequests(page, "oauth-consent")).toHaveLength(0);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.locator("main [role=alert]")).toContainText("Fixture stops navigation");
  const requests = await fixtureRequestBodies(page, "oauth-consent");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ accept: false });
});

test("a request without a usable return address cannot be approved", async ({ page }) => {
  await openConsent(page, { redirect: "" });
  await expect(page.locator("main [role=alert]")).toContainText("return address is missing or invalid");
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeDisabled();
  expect(await fixtureRequests(page, "oauth-consent")).toHaveLength(0);
});
