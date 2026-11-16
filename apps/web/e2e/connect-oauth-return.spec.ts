import { expect, test } from "./fixtures";
import { fixtureRequests, fixtureRule } from "./workspace-fixtures";
import { installApiFixtures } from "./in-page-api-fixtures";

test("a connect the desktop app started is handed back to the app, never finished by the browser", async ({ page }) => {
  await installApiFixtures(page);
  await fixtureRule(page, { id: "complete", pattern: "**/api/xmatrix/connectors/oauth/complete", method: "POST",
    responder: { kind: "static", status: 200, json: { redirect: "/app" } } });
  await page.goto("/connect/oauth?state=signed.state&code=one-use&via=desktop");

  await expect(page.getByText("The xMatrix app finishes the connection; you can close this tab.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open xMatrix" }))
    .toHaveAttribute("href", "xmatrix://connect/oauth?state=signed.state&code=one-use");
  // The one-use code leaves the address bar and is never exchanged with the browser's own session.
  expect(new URL(page.url()).search).toBe("");
  expect(await fixtureRequests(page, "complete")).toHaveLength(0);
  await page.screenshot({ path: "test-results/connect-return-to-app.png" });
});
