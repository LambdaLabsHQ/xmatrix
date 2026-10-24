import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_USER_SENDER,
  fixtureJson,
  fixtureRequestBodies,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

/* A message's hover actions are one paper bar riding the row's top edge, for a
   row with a header and one without. They used to float as a glass pill on the
   body of a header-less row, and the line underneath blurred into a smudge
   (user 2026-10-24). */

test.use(E2E_DESKTOP_CONTEXT);

const LONG_LINE =
  "Progress: the menu is gone, Share now carries the rules page toggle, and Attach can put a detached Automation back; next comes the repository docs entry on the tree row and open participation in Team.";
const OTHER = { kind: "user", label: "Daniel", userId: "u-daniel", email: "d@xmatrix.test", identityId: "user:u-daniel" };
const OWN = { ...E2E_USER_SENDER, identityId: "user:e2e-user" };
const REACTION_RULE = "hover-toolbar-reaction";

function history(from: unknown) {
  const sentAt = new Date(Date.parse(E2E_NOW) + 12 * 3_600_000).toISOString();
  return [
    { messageId: "m-1", channelId: E2E_CHANNEL.id, sequence: 1, body: "Starting on the page tree.", sentAt, from },
    { messageId: "m-2", channelId: E2E_CHANNEL.id, sequence: 2, body: LONG_LINE, sentAt, from },
  ];
}

async function open(page: Parameters<typeof openGeneralChannelWithHistory>[0], from: unknown) {
  const messages = history(from);
  await openGeneralChannelWithHistory(page, {
    ...E2E_CHANNEL,
    messageCount: messages.length,
    lastMessageSequence: messages.length,
    updatedAt: E2E_NOW,
  }, messages);
  return {
    first: page.locator(".app-message-timeline .app-message-row").filter({ hasText: "Starting on the page tree." }),
    continuation: page.locator(".app-message-timeline .app-message-row").filter({ hasText: "Progress: the menu is gone" }),
  };
}

test("the bar rides the row's top edge on paper and leaves its first line readable", async ({ page }) => {
  const { continuation: row } = await open(page, OTHER);
  await expect(row.locator(".app-message-continuation-gutter")).toHaveCount(1);
  const bar = row.locator(".app-message-hover-toolbar");
  await expect(bar).toHaveCSS("opacity", "0");
  // Hidden, it hangs over the row above and must not catch that row's pointer.
  await expect(bar).toHaveCSS("pointer-events", "none");
  await row.hover();
  await expect(bar).toHaveCSS("opacity", "1");

  const card = bar.getByRole("toolbar", { name: "Message actions" });
  await expect(card).toHaveAttribute("data-material", "paper-popover");
  const [cardBox, rowBox, textBox] = await Promise.all([
    card.boundingBox(),
    row.boundingBox(),
    row.getByText("Progress: the menu is gone").boundingBox(),
  ]);
  expect(cardBox!.y).toBeLessThan(rowBox!.y);
  // At most the leading above the first line's glyphs, never the glyphs.
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(textBox!.y + 5);

  // Edit and Recall are only for one's own messages.
  await expect(card.getByRole("button", { name: "More actions" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("message-hover-toolbar.png"), clip: {
    x: rowBox!.x, y: rowBox!.y - 40, width: rowBox!.width, height: rowBox!.height + 40,
  } });
});

test("the first row's bar stays inside the timeline", async ({ page }) => {
  const { first } = await open(page, OTHER);
  await first.hover();
  const card = first.getByRole("toolbar", { name: "Message actions" });
  await expect(first.locator(".app-message-hover-toolbar")).toHaveCSS("opacity", "1");
  const [cardBox, timelineBox] = await Promise.all([
    card.boundingBox(),
    page.locator(".app-message-timeline").boundingBox(),
  ]);
  expect(cardBox!.y).toBeGreaterThanOrEqual(timelineBox!.y);
});

test("a common reaction is one click, and R replies to the message under the pointer", async ({ page }) => {
  const { continuation: row } = await open(page, OTHER);
  await fixtureJson(page, REACTION_RULE, "**/api/xmatrix/channels/*/messages/*/reactions",
    { message: history(OTHER)[1] }, { method: "POST" });
  await row.hover();
  await row.getByRole("button", { name: "React ✅" }).click();
  await expect.poll(() => fixtureRequestBodies(page, REACTION_RULE)).toEqual([{ emoji: "✅" }]);

  // The picker holds the rest, so the bar and the picker never repeat one.
  // The bar answers only once its own row is under the pointer, and the
  // reaction may have moved the row out from under it.
  await row.hover();
  await row.getByRole("button", { name: "Add reaction" }).click();
  const picker = row.getByRole("toolbar", { name: "Quick reactions" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("button", { name: "React ✅" })).toHaveCount(0);
  const rowHeight = (await row.boundingBox())!.height;
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  expect((await row.boundingBox())!.height).toBe(rowHeight);

  await row.hover();
  await page.keyboard.press("r");
  await expect(page.getByText("Replying to Daniel")).toBeVisible();
});

test("one's own message keeps Edit and Recall behind More actions", async ({ page }) => {
  const { continuation: row } = await open(page, OWN);
  await row.hover();
  const card = row.getByRole("toolbar", { name: "Message actions" });
  await expect(card.getByRole("button", { name: /Edit|Recall/ })).toHaveCount(0);
  await card.getByRole("button", { name: "More actions" }).click();
  const menu = row.getByRole("menu", { name: "More message actions" });
  await expect(menu.getByRole("menuitem", { name: /Edit/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Recall/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Edit/ }).click();
  await expect(menu).toBeHidden();
  await expect(row.locator("textarea")).toBeVisible();
});
