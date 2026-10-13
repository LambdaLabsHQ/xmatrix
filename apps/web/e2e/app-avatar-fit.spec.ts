import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_NOW,
  openGeneralChannelWithHistory } from "./workspace-fixtures";

// Full vendor marks must remain inside the round message avatar. Object-contain
// alone still lets the circular clip cut off a logo's corners.
for (const [device, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["mobile", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(device, () => {
    test.use(context);
    test("Gmail's whole logo fits inside its avatar", async ({ page }) => {
      await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: 1,
        lastMessageSequence: 1, historyHeadSequence: 1, updatedAt: E2E_NOW }, [{
        messageId: "gmail-avatar", channelId: E2E_CHANNEL.id, sequence: 1,
        body: "Mail search completed", sentAt: E2E_NOW,
        from: { identityId: "app:gmail", kind: "app", label: "Gmail", name: "Gmail", userId: "", email: "",
          avatarUrl: "/app-connectors/gmail.svg" },
      }]);
      const image = page.locator('.message-author-avatar img[src="/app-connectors/gmail.svg"]');
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
      const fits = await image.evaluate((node: HTMLImageElement) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const width = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const height = box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        const scale = Math.min(width / node.naturalWidth, height / node.naturalHeight);
        const logoWidth = node.naturalWidth * scale;
        const logoHeight = node.naturalHeight * scale;
        const face = node.closest(".identity-avatar-face")!.getBoundingClientRect();
        return style.objectFit === "contain" && Math.hypot(logoWidth / 2, logoHeight / 2) < Math.min(face.width, face.height) / 2;
      });
      expect(fits, "the full logo's corners must stay within the avatar disc").toBe(true);
    });
  });
}
