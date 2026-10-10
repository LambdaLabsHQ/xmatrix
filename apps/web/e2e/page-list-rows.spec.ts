import { expect, test, type Locator } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_NOW, fixtureJson, installPageTreeStubs } from "./workspace-fixtures";

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

// The parser's unit tests cover syntax; this regression protects the Pages
// list actually using it, including the mobile list and its ellipsis layout.
for (const [device, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["mobile", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(device, () => {
    test.use(context);

    test("page summaries and discussion replies render inline rich text in one line", async ({ page }) => {
      await installPageTreeStubs(page, ["Summary", "Discussion"]);
      await fixtureJson(page, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, {
        pages: ["Summary", "Discussion"].map((title, index) => ({
          pageId: `p-${title.toLowerCase()}`, parentPageId: null, title, position: String.fromCharCode(86 + index),
          accessMode: "open", headRevision: 1, agentSuggestOnly: false, canEdit: true, updatedAt: E2E_NOW,
          summary: { text: "**状态**：已上线。 *shared* `syntax` ~~old~~ [notes](https://example.test) "
            + "![image](https://example.test/image.png) <b>literal</b> " + "Long summary. ".repeat(30) },
        })),
      });
      await fixtureJson(page, "page-agents", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\/agents$/u, {
        pages: [{ pageId: "p-discussion", agents: [], discussions: { open: 1, unread: 0,
          latest: { from: { kind: "user", label: "**Ada**" }, bodyPreview: "**Ship it** *Friday*?", sentAt: E2E_NOW } } }],
      });

      await page.goto("/app", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Pages", exact: true }).first().click();
      const summary = page.locator(".app-page-row:visible", { hasText: "Summary" }).locator(".app-list-row-meta");
      await expect(summary.locator("strong")).toHaveText("状态");
      await expect(summary.locator("em")).toHaveText("shared");
      await expect(summary.locator("code")).toHaveText("syntax");
      await expect(summary.locator("s")).toHaveText("old");
      await expect(summary).toContainText("notes image <b>literal</b>");
      await expect(summary.locator("a, img, b")).toHaveCount(0);
      expect(await summary.evaluate((element) => {
        const style = getComputedStyle(element);
        const strong = getComputedStyle(element.querySelector("strong")!);
        return { ellipsis: style.textOverflow, whiteSpace: style.whiteSpace,
          clipped: element.scrollWidth > element.clientWidth, height: element.getBoundingClientRect().height,
          bold: Number(strong.fontWeight) > Number(style.fontWeight) };
      })).toEqual({ ellipsis: "ellipsis", whiteSpace: "nowrap", clipped: true, height: 18, bold: true });

      const discussion = page.locator(".app-page-row:visible", { hasText: "Discussion" }).locator(".app-list-row-meta");
      await expect(discussion).toHaveText("**Ada**: Ship it Friday?");
      await expect(discussion.locator("strong")).toHaveText("Ship it");
      await expect(discussion.locator("em")).toHaveText("Friday");
    });
  });
}
