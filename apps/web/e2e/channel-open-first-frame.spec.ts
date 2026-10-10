import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { paintedRowMoves, paintedTimelineFrames, recordPaintedTimelineFrames } from "./painted-timeline-frames";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  E2E_USER_SENDER,
  channelHistoryFixture,
  conversationOpened,
  fixtureChannelCatalog,
  fixtureJson,
  installWorkspaceStubs,
} from "./workspace-fixtures";

/* Opening a conversation used to show an empty timeline for a quarter of a
   second - on a phone, for the whole slide - and then fill it in one frame:
   the virtual list keeps its rows hidden until it has landed on the last one
   (user 2026-10-10: "点开和回去频道的过程不丝滑…整个过程避免闪烁"). The conversation now
   opens on its last screen of rows, drawn in the commit that opens it, and
   the list takes them over where they are.

   Every painted frame is read, so this holds whatever the host's speed: no
   frame of an open conversation is without its newest message, and no message
   moves when the list takes over. */

const HISTORY_LENGTH = 30;
const NEWEST_ROW_ID = `message:first-frame-${HISTORY_LENGTH}`;

const GENERAL_ROW_ACTIVE = '[data-channel-row-id="channel-general"].app-channel-row-active';

/* Talk as it is: a word, a paragraph, a list, a block of code, a report. */
const UNEVEN_BODIES = [
  "ok",
  "A longer paragraph of talk. ".repeat(12),
  "Intro line\n\n- one\n- two\n- three\n\nOutro line.",
  "```ts\nconst a = 1;\nconst b = 2;\nconsole.log(a + b);\n```",
  `## Report\n\n${Array.from({ length: 12 }, (_, line) => `- finding ${line} ${"detail ".repeat(line * 3)}`).join("\n")}`,
  "Long prose. ".repeat(160),
  "A short line of talk.",
];

function unevenHistory(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `uneven-${index + 1}`,
    channelId: E2E_CHANNEL.id,
    sequence: index + 1,
    body: `#${index + 1} ${UNEVEN_BODIES[(index * 5) % UNEVEN_BODIES.length]}`,
    // Further apart than one sender's turn, so every message has its header.
    sentAt: new Date(Date.parse(E2E_NOW) + index * 660_000).toISOString(),
    from: E2E_USER_SENDER,
  }));
}

/** The catalog's two conversations, #general holding `messages` messages. */
function catalogWithGeneralAt(messages: number) {
  return [
    {
      ...E2E_CHANNEL, updatedAt: E2E_NOW, messageCount: messages, lastMessageSequence: messages,
      historyHeadSequence: messages, contentAuthority: { protocolVersion: 1, contentRevision: 1 },
    },
    { ...E2E_CHANNEL, id: "channel-quiet", name: "quiet", updatedAt: E2E_NOW },
  ];
}

async function openWorkspace(page: Page, path: string, history = channelHistoryFixture(HISTORY_LENGTH, "first-frame")) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: catalogWithGeneralAt(history.length) });
  await fixtureJson(page, "first-frame-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: history,
    hasMore: false,
  });
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

async function expectNewestMessageInEveryOpenFrame(page: Page, newestRowId = NEWEST_ROW_ID) {
  await expect(page.locator(`[id="${newestRowId}"]`)).toBeVisible();
  await conversationOpened(page);
  const open = (await paintedTimelineFrames(page)).filter((frame) => frame.open);
  expect(open.length).toBeGreaterThan(0);
  expect(open.filter((frame) => frame.tops[newestRowId] === undefined)).toEqual([]);
  // The newest message, and every other one that is drawn, stays where it is.
  expect(paintedRowMoves(open)).toEqual([]);
  return open;
}

/** Leaves #general for the other conversation, as a reader between two visits does. */
async function openQuietConversation(page: Page) {
  await clickConversationRow(page, "channel-quiet");
  await expect(page.locator('[data-channel-row-id="channel-quiet"].app-channel-row-active')).toBeVisible();
}

/* Through the mouse: a row is selected on pointer down and redrawn, and a
   locator click would press the new node a second time. */
async function clickConversationRow(page: Page, channelId: string) {
  const box = await page.locator(`[data-channel-row-id="${channelId}"]`).boundingBox();
  if (!box) throw new Error(`${channelId} has no row`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("a conversation slides in over the list with its newest message already in place", async ({ page }) => {
  await openWorkspace(page, "/app/personal-sspaceperso/channels");
  const row = page.locator('[data-mobile-channel-row-id="channel-general"]');
  const back = page.getByRole("button", { name: "Back to channels" });

  // Once from the network, then from what the first visit kept.
  for (const visit of ["first", "again"]) {
    if (visit === "again") await recordPaintedTimelineFrames(page, ".app-mobile-channel-detail-bar");
    await row.tap();
    await expect(page.locator(`[id="${NEWEST_ROW_ID}"]`)).toBeVisible();
    if (visit === "first") {
      await conversationOpened(page);
      await back.tap();
      await expect(page.locator(".app-mobile-channel-list-pane")).toBeVisible();
    }
  }
  await expectNewestMessageInEveryOpenFrame(page);
});

test.describe("desktop", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("switching to a conversation shows its newest message in the frame that switches", async ({ page }) => {
    await openWorkspace(page, "/app/personal-sspaceperso/channels/general-cchannelgen");
    await expect(page.locator(`[id="${NEWEST_ROW_ID}"]`)).toBeVisible();
    await conversationOpened(page);
    await openQuietConversation(page);

    await recordPaintedTimelineFrames(page, GENERAL_ROW_ACTIVE);
    await clickConversationRow(page, "channel-general");
    await expectNewestMessageInEveryOpenFrame(page);
  });

  /* The list takes the opening rows over only once it has measured its own.
     It used to take them the moment it had landed, drew the rows above them
     for the first time in that commit, and moved everything by the error of
     their estimated heights until its total height caught up a frame later
     (user 2026-10-10: "切换频道的时候，消息列表在抖动"). Messages of one height hide
     that, because every estimate is right; these are of many. */
  test("switching back to a conversation of uneven messages moves none of them", async ({ page }) => {
    const history = unevenHistory(60);
    const newestRowId = `message:uneven-${history.length}`;
    await openWorkspace(page, "/app/personal-sspaceperso/channels/general-cchannelgen", history);
    await expect(page.locator(`[id="${newestRowId}"]`)).toBeVisible();
    await conversationOpened(page);

    // A reopened conversation draws only the screen it showed last time, so
    // the list has the most rows of its own to measure. On a slow processor
    // its catching up takes longer than a frame, and that frame is painted.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    for (let visit = 0; visit < 5; visit += 1) {
      await openQuietConversation(page);
      await recordPaintedTimelineFrames(page, GENERAL_ROW_ACTIVE);
      await clickConversationRow(page, "channel-general");
      const frames = await expectNewestMessageInEveryOpenFrame(page, newestRowId);
      // The list is done measuring when it takes over: from that frame on its
      // content is as tall, and scrolled as far, as it stays.
      const tookOver = frames.filter((frame) => !frame.opening);
      expect(tookOver.length).toBeGreaterThan(0);
      expect(new Set(tookOver.map((frame) => `${frame.scrollTop} of ${frame.scrollHeight}`)).size).toBe(1);
    }
  });

  /* A scroll event reports where the timeline is a frame after it moved. When
     messages arrive while a conversation opens, the content has grown by then,
     and the event used to read as the reader leaving the newest message: the
     timeline stopped following and stood hundreds of pixels short of it. */
  test("messages that arrive while a conversation opens end with the newest one in view", async ({ page }) => {
    const history = unevenHistory(60);
    await openWorkspace(page, "/app/personal-sspaceperso/channels/general-cchannelgen", history);
    await expect(page.locator(`[id="message:uneven-${history.length}"]`)).toBeVisible();
    await conversationOpened(page);

    for (const arrived of [62, 65]) {
      await openQuietConversation(page);
      // The list says #general has grown. Its kept messages are on screen at
      // once; the newer ones reach it a moment later, while the list is still
      // taking over.
      await fixtureChannelCatalog(page, `catalog-${arrived}`, catalogWithGeneralAt(arrived));
      await fixtureJson(page, `arrived-${arrived}`, "**/api/xmatrix/channels/channel-general/history**", {
        messages: unevenHistory(arrived),
        hasMore: false,
        historyHeadSequence: arrived,
        contentAuthority: { protocolVersion: 1, contentRevision: 1 },
      }, { delayMs: 200 });
      await page.evaluate((spaceId) => window.dispatchEvent(new CustomEvent(
        "xmatrix:channel-catalog-change", { detail: { spaceId, kind: "structure" } },
      )), E2E_SPACE.id);
      await clickConversationRow(page, "channel-general");
      await expect(page.locator(`[id="message:uneven-${arrived}"]`)).toBeVisible();
      await conversationOpened(page);
      await expect.poll(() => page.locator(".app-message-timeline").evaluate((timeline) =>
        Math.round(timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop))).toBe(0);
    }
  });
});
