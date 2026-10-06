import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_USER_SENDER, openGeneralChannelWithHistory } from "./workspace-fixtures";

const LONG_TOKEN = `mobile-${"horizontal-overflow-".repeat(16)}`;
const MESSAGE_BODY = [
  "Long message content stays inside the mobile timeline.",
  "",
  "```text",
  LONG_TOKEN,
  "```",
  "",
  "| First column | Second column |",
  "| --- | --- |",
  `| ${LONG_TOKEN} | ${LONG_TOKEN} |`,
].join("\n");

test("mobile chat timeline stays fixed while wide content scrolls independently", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-01T12:00:00Z"));
  const channel = {
    ...E2E_CHANNEL,
    messageCount: 1,
    lastMessageSequence: 1,
    updatedAt: E2E_NOW,
  };
  const history = [{
    messageId: "message-mobile-overflow",
    channelId: E2E_CHANNEL.id,
    sequence: 1,
    body: MESSAGE_BODY,
    sentAt: E2E_NOW,
    from: E2E_USER_SENDER,
  }];

  await openGeneralChannelWithHistory(page, channel, history);
  await expect(page.locator(".app-message-timeline").getByText("Long message content stays inside the mobile timeline.")).toBeVisible();
  const messageRow = page.locator(".app-message-row", {
    hasText: "Long message content stays inside the mobile timeline.",
  });
  const messageTimestamp = messageRow.locator(".app-message-timestamp");
  await expect(messageTimestamp).not.toContainText("2026");
  await expect(messageTimestamp).toHaveAttribute("title", /2026/);
  await expect.poll(async () => {
    const [root, face] = await Promise.all([
      messageRow.locator(".identity-avatar").boundingBox(),
      messageRow.locator(".identity-avatar-face").boundingBox(),
    ]);
    return {
      root: root && [root.width, root.height],
      face: face && [face.width, face.height],
    };
  }).toEqual({
    root: [40, 40],
    face: [40, 40],
  });
  // No day divider: the header timestamp carries the day.
  await expect(page.getByRole("separator", { name: /2026/ })).toHaveCount(0);

  const timeline = page.locator(".app-message-timeline");
  const code = timeline.locator(".message-code-scroll");
  const tableScroller = timeline.locator(".message-table-scroll");
  await expect(code).toBeVisible();
  await expect(tableScroller).toBeVisible();

  await expect.poll(() => timeline.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflowX: style.overflowX,
      overscrollBehaviorX: style.overscrollBehaviorX,
    };
  })).toEqual({
    overflowX: "hidden",
    overscrollBehaviorX: "none",
  });

  for (const contentScroller of [code, tableScroller]) {
    await expect.poll(() => contentScroller.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
        overflowX: style.overflowX,
        overscrollBehaviorX: style.overscrollBehaviorX,
        touchAction: style.touchAction,
      };
    })).toEqual({
      hasHorizontalOverflow: true,
      overflowX: "auto",
      overscrollBehaviorX: "contain",
      touchAction: "pan-x pan-y",
    });

    const horizontalScrollLeft = await contentScroller.evaluate((element) => {
      element.scrollLeft = 100;
      return element.scrollLeft;
    });
    expect(horizontalScrollLeft).toBeGreaterThan(0);
  }
});

test("mobile messages can scroll completely above the floating instance control", async ({ page }) => {
  const channel = {
    ...E2E_CHANNEL,
    messageCount: 8,
    lastMessageSequence: 8,
    updatedAt: E2E_NOW,
    memberPresence: {
      "agent:codex": {
        kind: "agent",
        status: "busy",
        label: "Codex",
        instances: [{
          id: "instance-codex-mobile-clearance",
          channelInstanceId: "1",
          label: "codex:1",
          connectedAt: E2E_NOW,
          lastSeenAt: E2E_NOW,
          status: "busy",
        }],
      },
    },
  };
  const history = Array.from({ length: 8 }, (_, index) => ({
    messageId: `message-mobile-clearance-${index + 1}`,
    channelId: E2E_CHANNEL.id,
    sequence: index + 1,
    body: `Scrollable message ${index + 1}. ${"Enough content to fill the mobile timeline. ".repeat(3)}`,
    sentAt: new Date(Date.parse(E2E_NOW) + index * 1_000).toISOString(),
    from: E2E_USER_SENDER,
  }));

  await openGeneralChannelWithHistory(page, channel, history);
  const timeline = page.locator(".app-message-timeline");
  const instanceControl = page.getByRole("button", { name: /Open Codex.*codex:1/ });
  const lastMessage = page.locator(".app-message-row").last();
  await expect(instanceControl).toBeVisible();
  await expect(lastMessage).toBeVisible();

  await timeline.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  await expect.poll(async () => {
    const [lastMessageBox, instanceBox] = await Promise.all([
      lastMessage.boundingBox(),
      instanceControl.boundingBox(),
    ]);
    if (!lastMessageBox || !instanceBox) return Number.NEGATIVE_INFINITY;
    return instanceBox.y - (lastMessageBox.y + lastMessageBox.height);
  }).toBeGreaterThanOrEqual(12);
});
