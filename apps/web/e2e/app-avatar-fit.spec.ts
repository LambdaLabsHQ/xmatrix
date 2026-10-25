import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_NOW,
  openGeneralChannelWithHistory } from "./workspace-fixtures";

// An App's mark is its own artwork: it sits whole on a plain white disc, with
// no tint, glass edge or ring over it, and no corner clipped by the disc.
for (const [device, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["mobile", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(device, () => {
    test.use(context);
    test("Gmail's whole logo sits on a plain white disc in its avatar", async ({ page }) => {
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
      const look = await image.evaluate((node: HTMLImageElement) => {
        const style = getComputedStyle(node);
        const faceNode = node.closest(".identity-avatar-face")!;
        const face = getComputedStyle(faceNode);
        const box = node.getBoundingClientRect();
        const width = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const height = box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        const scale = Math.min(width / node.naturalWidth, height / node.naturalHeight);
        const faceBox = faceNode.getBoundingClientRect();
        return {
          objectFit: style.objectFit,
          fitsDisc: Math.hypot(node.naturalWidth * scale / 2, node.naturalHeight * scale / 2) < Math.min(faceBox.width, faceBox.height) / 2,
          background: face.backgroundColor,
          boxShadow: face.boxShadow,
        };
      });
      expect(look.objectFit).toBe("contain");
      expect(look.fitsDisc, "the full logo's corners must stay within the avatar disc").toBe(true);
      expect(look.background, "a plain white disc").toBe("rgb(255, 255, 255)");
      expect(look.boxShadow, "no ring over the mark").toBe("none");
    });
  });
}
