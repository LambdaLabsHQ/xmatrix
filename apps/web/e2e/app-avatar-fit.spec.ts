import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_NOW,
  openGeneralChannelWithHistory } from "./workspace-fixtures";

// An App's mark is its own artwork: it stands whole and bare, edge to edge,
// with no disc, edge or ring around it that could clip it or shrink it.
for (const [device, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["mobile", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(device, () => {
    test.use(context);
    test("Gmail's whole logo stands bare, edge to edge, in its avatar", async ({ page }) => {
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
        const faceBox = faceNode.getBoundingClientRect();
        const scale = Math.min(box.width / node.naturalWidth, box.height / node.naturalHeight);
        return {
          objectFit: style.objectFit,
          padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingTop),
          logoWidth: Math.round(node.naturalWidth * scale),
          faceWidth: Math.round(faceBox.width),
          background: face.backgroundColor,
          boxShadow: face.boxShadow,
          overflow: face.overflow,
        };
      });
      expect(look.objectFit).toBe("contain");
      expect(look.padding, "the mark is not inset").toBe(0);
      expect(look.logoWidth, "the mark spans the avatar edge to edge").toBe(look.faceWidth);
      expect(look.background, "no disc behind the mark").toBe("rgba(0, 0, 0, 0)");
      expect(look.boxShadow, "no ring around the mark").toBe("none");
      expect(look.overflow, "nothing clips the mark").toBe("visible");
    });
  });
}
