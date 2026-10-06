import { expect, test, type Locator } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, installPageTreeStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

function band(row: Locator) {
  return row.evaluate((element) => {
    // Read the settled tone, not a frame of the hover transition.
    for (const animation of element.getAnimations()) animation.finish();
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const list = element.closest(".app-sidebar")!.getBoundingClientRect();
    return { background: style.backgroundColor, radius: style.borderRadius, inset: box.left - list.left };
  });
}

test("a page row highlights like a conversation row: a full-width paper band, no pill on its title", async ({ page }) => {
  await installPageTreeStubs(page, ["Relay", "Notes"]);

  await page.goto("/app", { waitUntil: "domcontentloaded" });
  const chatRow = page.locator(".app-channel-row.app-channel-chat-row").first();
  await expect(chatRow).toBeVisible({ timeout: 30_000 });
  await chatRow.hover();
  const chat = await band(chatRow);
  expect(chat.background).not.toBe("rgba(0, 0, 0, 0)");

  await page.getByRole("button", { name: "Pages", exact: true }).first().click();
  const relay = page.locator(".app-page-row", { hasText: "Relay" });
  await relay.getByRole("button", { name: "Relay" }).click();
  await expect(relay).toHaveClass(/font-semibold/u);

  const notes = page.locator(".app-page-row", { hasText: "Notes" });
  const notesTitle = notes.getByRole("button", { name: "Notes" });
  await notesTitle.hover();
  await expect.poll(async () => (await band(notes)).background).toBe(chat.background);
  expect(await band(notes)).toEqual(chat);
  expect(await notesTitle.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.boxShadow];
  })).toEqual(["rgba(0, 0, 0, 0)", "none"]);

  expect(await band(relay)).toEqual(chat);
});

test("page list titles use the same 16px inscription as channel rows", async ({ page }) => {
  await installPageTreeStubs(page, ["Company"]);

  await page.goto("/app", { waitUntil: "domcontentloaded" });
  const channelTitle = page.locator(".app-channel-row:visible span.truncate", { hasText: "general" });
  await expect(channelTitle).toBeVisible({ timeout: 30_000 });
  const channelSize = await channelTitle.evaluate((element) => getComputedStyle(element).fontSize);

  await page.getByRole("button", { name: "Pages", exact: true }).first().click();
  const pageTitle = page.locator(".app-page-row span.app-page-row-title", { hasText: "Company" });
  await expect(pageTitle).toBeVisible();
  const pageSize = await pageTitle.evaluate((element) => getComputedStyle(element).fontSize);

  expect(channelSize).toBe("16px");
  expect(pageSize).toBe(channelSize);
});
