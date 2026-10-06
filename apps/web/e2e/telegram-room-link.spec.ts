import { test, expect, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, fixtureJson, fixtureRequestBodies, openWorkspaceWithStubs, fixtureRule, fixtureRequests, releaseFixture } from "./workspace-fixtures";
test.use(E2E_DESKTOP_CONTEXT);
const room = "-100123456789", nonce = "N".repeat(32), botUsername = "xMatrixFixtureBot";
const endpoint = /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/telegram\/link$/;
const confirmation = () => ({ chatSpace: room, nonce, botUsername, expiresAt: new Date(Date.now()+180000).toISOString() });
async function openTelegram(page: Page) {
  await openWorkspaceWithStubs(page, { channels: [E2E_CHANNEL], spaces: [E2E_SPACE] });
  await fixtureJson(page, "telegram-provider", "**/api/xmatrix/connectors/oauth/providers", { nativeProviders: ["telegram"], providers: [] });
  await fixtureJson(page, "telegram-rows", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [] });
  await fixtureJson(page, "telegram-prepare", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/telegram$/, { connection: { id: `${E2E_SPACE.id}:telegram`, providerId: "telegram", status: "disconnected" } }, { method: "PATCH" });
  await fixtureJson(page, "telegram-activity", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: "Telegram" }).click();
  await page.getByLabel("Telegram group chat ID").fill(room);
}
const start = (page: Page) => page.getByRole("button", { name: "Start confirmation", exact: true }).click();
test("Telegram requires a negative group and shows a private command addressed to the verified bot", async ({ page }) => {
  await openTelegram(page); await page.getByLabel("Telegram group chat ID").fill("123");
  await expect(page.getByRole("button", { name: "Start confirmation", exact: true })).toBeDisabled();
  await page.getByLabel("Telegram group chat ID").fill(room);
  await fixtureJson(page, "telegram-confirm", endpoint, confirmation(), { method: "POST" }); await start(page);
  await expect(page.getByText(`/xmatrix_link@${botUsername} ${nonce}`, { exact: true })).toBeVisible();
  expect(await fixtureRequestBodies(page, "telegram-confirm")).toEqual([{ chatId: room }]);
  expect(await page.evaluate(() => JSON.stringify([location.href, { ...localStorage }, { ...sessionStorage }]))).not.toContain(nonce);
  await expect(page.getByText("A Telegram group administrator", { exact: false })).toBeVisible();
});
test("Telegram missing bot identity and late responses cannot leave a usable private challenge", async ({ page }) => {
  await openTelegram(page);
  await fixtureJson(page, "telegram-no-bot", endpoint, { ...confirmation(), botUsername: "wrong space" }, { method: "POST" }); await start(page);
  await expect(page.locator("#telegram-room-link").getByRole("alert")).toContainText("confirmation expired");
  await fixtureRule(page, { id: "telegram-delayed", pattern: endpoint, method: "POST", responder: { kind: "deferred", json: confirmation() } });
  await start(page); await expect.poll(async () => (await fixtureRequests(page, "telegram-delayed")).length).toBe(1);
  await page.getByTestId("connector-row").filter({ hasText: "Linear" }).click(); await releaseFixture(page, "telegram-delayed");
  await page.getByTestId("connector-row").filter({ hasText: "Telegram" }).click();
  await expect(page.getByText(`/xmatrix_link@${botUsername} ${nonce}`, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Telegram group chat ID")).toHaveValue("");
});
test("Telegram refresh lists exact authorized groups and unlink posts only its selected group", async ({ page }) => {
  await openTelegram(page);
  await fixtureJson(page, "telegram-list", endpoint, { bindings: [{ chatSpace: room, sourceRef: `telegram:${room}` }, { chatSpace: "-222", sourceRef: "telegram:-222" }] }, { method: "GET" });
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click();
  await expect(page.getByText("Connected Telegram group:", { exact: false })).toHaveCount(2);
  await fixtureJson(page, "telegram-remove", endpoint, { ok: true }, { method: "DELETE" });
  await page.getByRole("button", { name: "Unlink group", exact: true }).first().click();
  expect(await fixtureRequestBodies(page, "telegram-remove")).toEqual([{ chatId: room }]);
  await expect(page.getByText("Connected Telegram group:", { exact: false })).toHaveCount(1);
});
