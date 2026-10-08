import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_USER_SENDER,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

/* A message moments after another from the same sender drops its header, so
   its hover actions float at the top right of the body. They used to float with
   no surface of their own, and a line long enough to reach them was drawn
   straight through the icons (user 2026-10-03). The reaction picker under them
   is glass too, and glass is always position: relative, so it fell into the
   row and pushed the message down instead of floating. */

test.use(E2E_DESKTOP_CONTEXT);

const LONG_LINE =
  "Progress: the menu is gone, Share now carries the rules page toggle, and Attach can put a detached Automation back; next comes the repository docs entry on the tree row and open participation in Team.";

test("hover actions on a header-less message sit on glass, and the reaction picker floats", async ({ page }) => {
  const sentAt = new Date(Date.parse(E2E_NOW) + 12 * 3_600_000).toISOString();
  const from = { ...E2E_USER_SENDER, identityId: "user:e2e-user" };
  await openGeneralChannelWithHistory(page, {
    ...E2E_CHANNEL,
    messageCount: 2,
    lastMessageSequence: 2,
    updatedAt: E2E_NOW,
  }, [
    { messageId: "m-1", channelId: E2E_CHANNEL.id, sequence: 1, body: "Starting on the page tree.", sentAt, from },
    { messageId: "m-2", channelId: E2E_CHANNEL.id, sequence: 2, body: LONG_LINE, sentAt, from },
  ]);

  const row = page.locator(".app-message-row").filter({ hasText: "Progress: the menu is gone" });
  await expect(row.locator(".app-message-continuation-gutter")).toHaveCount(1);
  const actions = row.locator(".app-message-floating-actions");
  await expect(actions).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(actions).toHaveCSS("opacity", "1");

  const glass = actions.locator('[data-material="liquid-glass-pill"]');
  const reply = actions.getByRole("button", { name: "Reply" });
  const text = row.getByText("Progress: the menu is gone");
  const [glassBox, replyBox, textBox] = await Promise.all([glass.boundingBox(), reply.boundingBox(), text.boundingBox()]);
  // The case under test: the body's first line runs underneath the actions,
  // and the glass is behind every one of them.
  expect(glassBox!.x).toBeLessThan(textBox!.x + textBox!.width);
  expect(glassBox!.y).toBeLessThan(textBox!.y + textBox!.height);
  expect(replyBox!.x).toBeGreaterThanOrEqual(glassBox!.x);
  expect(replyBox!.x + replyBox!.width).toBeLessThanOrEqual(glassBox!.x + glassBox!.width);
  // The hover fill shares the capsule's centres: a 4px square inside a full
  // round pill read as misaligned corners (user 2026-10-08).
  const replyRadius = await reply.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
  expect(replyRadius).toBeGreaterThanOrEqual(replyBox!.height / 2);

  await page.screenshot({ path: test.info().outputPath("message-floating-actions.png"), clip: await row.boundingBox() ?? undefined });

  // Opening the picker must not move the message.
  const rowHeight = (await row.boundingBox())!.height;
  await actions.getByRole("button", { name: "Add reaction" }).click();
  const picker = row.getByRole("button", { name: "React 👍" });
  await expect(picker).toBeVisible();
  expect((await row.boundingBox())!.height).toBe(rowHeight);
  const pickerBox = (await picker.boundingBox())!;
  expect(pickerBox.y).toBeGreaterThan(glassBox!.y + glassBox!.height - 1);
});
