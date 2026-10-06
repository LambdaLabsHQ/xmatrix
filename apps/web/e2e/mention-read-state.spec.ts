import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import {
  E2E_CHANNEL,
  E2E_NOW,
  E2E_SPACE,
  E2E_USER_SENDER,
  fixtureJson,
  installWorkspaceStubs,
} from "./workspace-fixtures";

/* Mention receipts are derived from the channel's member cursor. The status
   stays at the `@` itself as a compact marker that opens its own receipt. */

/* A Human is addressed by handle, never by display name: display names are
   unique nowhere, and matching them is what let a mention of one person
   highlight and notify another. */
const READER = {
  userId: "u-reader",
  email: "reader@xmatrix.test",
  name: "Mika Reader",
  handle: "mika-reader",
  role: "member",
  joinedAt: E2E_NOW,
};
const READER_AT = `@${READER.handle}`;

const SPACE = {
  ...E2E_SPACE,
  members: [...E2E_SPACE.members, READER],
};

const CHANNEL = {
  ...E2E_CHANNEL,
  messageCount: 2,
  historyHeadSequence: 2,
  memberReadSequences: { "user:u-reader": 1 },
  memberPresence: {
    "user:u-reader": { kind: "user", label: READER.name, status: "online" },
  },
};

const HISTORY = [1, 2].map((sequence) => ({
  messageId: `message-${sequence}`,
  channelId: CHANNEL.id,
  sequence,
  body: `${READER_AT} message ${sequence}`,
  sentAt: new Date(Date.parse(E2E_NOW) + sequence * 1000).toISOString(),
  from: E2E_USER_SENDER,
}));

async function openChannel(page: Page, channel: unknown, history = HISTORY) {
  await installWorkspaceStubs(page, { spaces: [SPACE], channels: [channel] });
  await fixtureJson(
    page,
    "channel-general-history",
    "**/api/xmatrix/channels/channel-general/history**",
    { messages: history, hasMore: false }
  );
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
}

test.use({ viewport: { width: 1512, height: 945 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

test.describe("mention read state", () => {
  test("a mention exposes a Feishu-style receipt for a passed cursor and an unread cursor", async ({ page }) => {
    await openChannel(page, CHANNEL);

    const chips = page.locator(".app-mention-chip");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveAttribute("data-read-state", "read");
    await expect(chips.nth(1)).toHaveAttribute("data-read-state", "unread");
    await expect(chips.nth(0)).toContainText(`@${READER.name}`);

    await chips.nth(1).getByRole("button", { name: `${READER.name}: Unread` }).click();
    const receipt = page.getByTestId("mention-read-receipt");
    await expect(receipt).toContainText(`@${READER.name}`);
    await expect(receipt).toContainText("Unread");
  });

  test("a channel with no read projection renders the mention as unknown", async ({ page }) => {
    const { memberReadSequences: _omitted, ...channelWithoutCursors } = CHANNEL;
    await openChannel(page, channelWithoutCursors);

    const chips = page.locator(".app-mention-chip");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveAttribute("data-read-state", "unknown");
    await chips.nth(0).getByRole("button", { name: `${READER.name}: Unknown` }).click();
    await expect(page.getByTestId("mention-read-receipt")).toContainText("Unknown");
  });

  test("a mention chip preserves complete summon and reborn commands", async ({ page }) => {
    const commandHistory = [
      { ...HISTORY[0], body: "@mika-reader:new:LambdaLabsHQ/xmatrix" },
      { ...HISTORY[1], body: "@mika-reader:3:reborn" },
    ];
    await openChannel(page, CHANNEL, commandHistory);

    const chips = page.locator(".app-mention-chip");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText("@Mika Reader:new:LambdaLabsHQ/xmatrix");
    await expect(chips.nth(1)).toContainText("@Mika Reader:3:reborn");
    await expect(chips.nth(0)).toHaveCSS("white-space", "normal");
    // Per-line pill fragments: avoids a tall flex capsule overlapping wrapped lines.
    await expect(chips.nth(0)).toHaveCSS("display", "inline");
    await expect(chips.nth(0)).toHaveCSS("box-decoration-break", "clone");
    await expect(chips.nth(0).locator(".app-mention-chip-label")).toHaveCSS("text-overflow", "clip");
  });

  test("read receipt stays on the avatar when a long summon mention wraps", async ({ page }) => {
    // Narrow the timeline so the long summon label must wrap across lines.
    await page.setViewportSize({ width: 420, height: 900 });
    const commandHistory = [
      {
        ...HISTORY[0],
        body: "@mika-reader:new:LambdaLabsHQ/xmatrix-with-a-very-long-repo-name-for-wrap",
      },
      { ...HISTORY[1], body: "@mika-reader please review" },
    ];
    await openChannel(page, CHANNEL, commandHistory);

    const chip = page.locator(".app-mention-chip").first();
    const avatar = chip.locator(".app-mention-chip-avatar");
    const receipt = chip.locator(".app-mention-chip-receipt");
    await expect(avatar.locator(".app-mention-chip-receipt")).toHaveCount(1);

    const avatarBox = await avatar.boundingBox();
    const receiptBox = await receipt.boundingBox();
    expect(avatarBox).toBeTruthy();
    expect(receiptBox).toBeTruthy();
    if (!avatarBox || !receiptBox) return;

    // Receipt is anchored to the avatar corner, not the far right of the multi-line chip.
    const receiptCenterX = receiptBox.x + receiptBox.width / 2;
    const receiptCenterY = receiptBox.y + receiptBox.height / 2;
    expect(receiptCenterX).toBeGreaterThan(avatarBox.x - 4);
    expect(receiptCenterX).toBeLessThan(avatarBox.x + avatarBox.width + 10);
    expect(receiptCenterY).toBeGreaterThan(avatarBox.y - 8);
    expect(receiptCenterY).toBeLessThan(avatarBox.y + avatarBox.height + 8);

    await receipt.getByRole("button", { name: /: Read$/ }).click();
    await expect(page.getByTestId("mention-read-receipt")).toContainText("Read");
  });

  test("a mention pill stays inside its line and centres its avatar", async ({ page }) => {
    const history = [{ ...HISTORY[0], body: `请 ${READER_AT} 看一下，${READER_AT} 的输出也看看（${READER_AT}），${READER_AT} ${READER_AT}` }];
    await openChannel(page, { ...CHANNEL, messageCount: 1, historyHeadSequence: 1 }, history);
    await expect(page.locator(".app-mention-chip").first()).toBeVisible();
    const chips = await page.locator(".app-mention-chip").evaluateAll(elements => elements.map(chip => {
      const line = parseFloat(getComputedStyle(chip.closest("p") ?? chip.parentElement!).lineHeight);
      const face = chip.querySelector(".app-mention-chip-avatar-face")!.getBoundingClientRect();
      const first = chip.getClientRects()[0]!;
      return { line, fragments: [...chip.getClientRects()].map(rect => rect.height), face: face.toJSON(),
        pill: { top: first.top, bottom: first.bottom } };
    }));
    expect(chips.length).toBeGreaterThan(1);
    for (const chip of chips) {
      // Pills on two lines never meet: each is shorter than its line.
      for (const height of chip.fragments) expect(height).toBeLessThan(chip.line - 0.5);
      // The avatar sits inside the pill, centred on it.
      expect(chip.face.top).toBeGreaterThanOrEqual(chip.pill.top);
      expect(chip.face.bottom).toBeLessThanOrEqual(chip.pill.bottom);
      expect(Math.abs((chip.face.top + chip.face.bottom) / 2 - (chip.pill.top + chip.pill.bottom) / 2)).toBeLessThanOrEqual(1);
    }
  });
});
