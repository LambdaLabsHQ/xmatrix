import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_NOW,
  E2E_DESKTOP_CONTEXT,
  E2E_MOBILE_CONTEXT,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

for (const [name, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["mobile", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(name, () => {
    test.use(context);

    test("long message expands from its arrow and button padding", async ({ page }) => {
      await openGeneralChannelWithHistory(page, {
        ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1,
      }, [{
        messageId: "message-collapse", channelId: E2E_CHANNEL.id, sequence: 1,
        sentAt: E2E_NOW,
        from: {
          identityId: "agent:codex", kind: "agent", label: "Codex",
          userId: "agent-owner", email: "codex@xmatrix.test", agentName: "Codex",
          instanceId: "instance-codex-1", channelInstanceId: "1", instanceLabel: "Codex:1",
        },
        body: `${"A long message paragraph for expansion testing.\n\n".repeat(150)}END OF LONG MESSAGE`,
      }]);
      const row = page.locator(".app-message-row").filter({ hasText: "A long message paragraph" });
      const button = row.getByRole("button", { name: "Show more", exact: true });
      const content = row.locator(".rich-message");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await button.scrollIntoViewIfNeeded();
      const buttonBox = await button.boundingBox();
      // Phones keep the 44px touch target; on desktop the disclosure matches
      // the 8-unit chip beside it (Reply in thread) so the action row aligns.
      expect(buttonBox?.height).toBeGreaterThanOrEqual(context.hasTouch ? 44 : 32);
      const arrowBox = await button.locator("svg").boundingBox();
      expect(arrowBox).not.toBeNull();
      const point = { x: arrowBox!.x + arrowBox!.width / 2, y: arrowBox!.y + arrowBox!.height / 2 };
      expect(await button.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, point)).toBe(true);
      if (context.hasTouch) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
      await expect(button).toHaveCount(0);
      await expect(content).not.toHaveClass(/rich-message-collapsed/);
      await expect(content).toContainText("END OF LONG MESSAGE");
      const less = row.getByRole("button", { name: "Show less", exact: true });
      await less.click();
      await expect(content).toHaveClass(/rich-message-collapsed/);
      // Collapsing reflows the virtualized row. Resolve and stabilize the
      // current button as part of the action instead of retaining its old box.
      // The disclosure is a capsule chip, so its corners fall outside the hit
      // area: click the horizontal padding at mid-height instead of (4, 4).
      const box = await button.boundingBox();
      const padding = { x: 6, y: (box?.height ?? 44) / 2 };
      if (context.hasTouch) await button.tap({ position: padding });
      else await button.click({ position: padding });
      await expect(less).toHaveAttribute("aria-expanded", "true");
      await expect(content).toContainText("END OF LONG MESSAGE");
      await less.focus();
      await page.keyboard.press("Enter");
      await expect(button).toHaveAttribute("aria-expanded", "false");
    });
  });
}
