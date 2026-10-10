import { expect, test, type Page } from "./fixtures";
import {
  E2E_DESKTOP_CONTEXT,
  E2E_USER_SENDER,
  channelHistoryFixture,
  openGeneralChannelWithPagedHistory,
  requestedHistoryCursors,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

/* The quoted message sits far outside the first history page on purpose. That
   is the whole failure this covers: a reply preview used to be a bare `#`
   anchor, so the jump could only ever find a row the virtualizer had already
   mounted — which the quoted message, tens of rows up, never is. */
const MESSAGE_COUNT = 56;
const HEAD_QUOTED_SEQUENCE = 3;
/* Deep enough that the seek page puts it in the middle of the loaded window:
   seeking 30 loads 1..30, which merges with the 47..56 tail. A landing that
   was clamped to index 0, or that never moved, cannot fake this one. */
const MID_QUOTED_SEQUENCE = 30;
const NEWEST_BODY = "The newest message quotes an older one.";

type HistoryMessage = {
  messageId: string;
  channelId: string;
  sequence: number;
  body: string;
  sentAt: string;
  from: typeof E2E_USER_SENDER;
  replyToMessageId?: string;
  replyTo?: {
    messageId: string;
    from: typeof E2E_USER_SENDER;
    bodyPreview: string;
    sentAt: string;
    sequence?: number;
  };
};

function messageIdFor(sequence: number) {
  return `message-jump-${sequence}`;
}

function historyFixture(options: {
  quotedSequence: number;
  previewCarriesSequence: boolean;
}): HistoryMessage[] {
  const messages: HistoryMessage[] = channelHistoryFixture(MESSAGE_COUNT, "message-jump");
  const quoted = messages[options.quotedSequence - 1];
  const newest = messages[messages.length - 1];
  newest.body = NEWEST_BODY;
  newest.replyToMessageId = quoted.messageId;
  newest.replyTo = {
    messageId: quoted.messageId,
    from: E2E_USER_SENDER,
    bodyPreview: quoted.body,
    sentAt: quoted.sentAt,
    ...(options.previewCarriesSequence ? { sequence: quoted.sequence } : {}),
  };
  return messages;
}

async function openChannel(page: Page, history: HistoryMessage[]) {
  await openGeneralChannelWithPagedHistory(page, history);
  await expect(page.locator(".app-message-timeline").getByText(NEWEST_BODY)).toBeVisible();
}

function messageRow(page: Page, sequence: number) {
  return page.locator(`#message\\:${messageIdFor(sequence)}`);
}

function replyPreview(page: Page, sequence: number) {
  return page.locator(`a[href="#message:${messageIdFor(sequence)}"]`);
}

async function expectLandedOn(page: Page, sequence: number) {
  const row = messageRow(page, sequence);
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/message-jump-highlight/);
  // Landed means "in the viewport", not merely "mounted somewhere".
  const inViewport = await row.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  });
  expect(inViewport).toBe(true);
}

/* Virtuoso's imperative index space is the data index. Passing an index from
   the wrong space is clamped into range rather than rejected, so a target near
   either end of the window cannot tell a correct landing from a clamped one.
   The mid target is deep inside the window and the landing is centred, so an
   off-by-firstItemIndex jump lands somewhere provably else. */
async function expectCentred(page: Page, sequence: number) {
  const placement = await messageRow(page, sequence).evaluate((element) => {
    const container = element.closest(".app-message-timeline");
    if (!(container instanceof HTMLElement)) throw new Error("timeline scroll container not found");
    const containerRect = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      offsetFromCentre: Math.abs(
        (rect.top + rect.bottom) / 2 - (containerRect.top + containerRect.bottom) / 2
      ),
      containerHeight: containerRect.height,
    };
  });
  expect(placement.offsetFromCentre).toBeLessThan(placement.containerHeight * 0.3);
}

test("clicking a quoted message seeks to it by sequence and lands on the row", async ({ page }) => {
  const history = historyFixture({
    quotedSequence: HEAD_QUOTED_SEQUENCE,
    previewCarriesSequence: true,
  });
  await openChannel(page, history);

  // The quoted message is older than the first page, so it is not rendered yet.
  await expect(messageRow(page, HEAD_QUOTED_SEQUENCE)).toHaveCount(0);

  await replyPreview(page, HEAD_QUOTED_SEQUENCE).click();

  // beforeSequence is exclusive, so seeking sequence 3 asks for 4.
  await expect
    .poll(async () => (await requestedHistoryCursors(page)).includes(HEAD_QUOTED_SEQUENCE + 1))
    .toBe(true);
  await expectLandedOn(page, HEAD_QUOTED_SEQUENCE);
});

test("a quote in the middle of the loaded window is centred, not clamped", async ({ page }) => {
  const history = historyFixture({
    quotedSequence: MID_QUOTED_SEQUENCE,
    previewCarriesSequence: true,
  });
  await openChannel(page, history);
  await expect(messageRow(page, MID_QUOTED_SEQUENCE)).toHaveCount(0);

  await replyPreview(page, MID_QUOTED_SEQUENCE).click();
  await expectLandedOn(page, MID_QUOTED_SEQUENCE);

  await expectCentred(page, MID_QUOTED_SEQUENCE);

  // A landing that never moved would have left the tail on screen.
  await expect(page.locator(".app-message-timeline").getByText(NEWEST_BODY)).not.toBeInViewport();
  // A landing clamped to index 0 would have put the oldest loaded row on screen.
  await expect(messageRow(page, 1)).not.toBeInViewport();
});

test("a quote clicked while the conversation is still opening is centred", async ({ page }) => {
  const history = historyFixture({
    quotedSequence: MID_QUOTED_SEQUENCE,
    previewCarriesSequence: true,
  });
  // The conversation opens on a plain tail of its rows while the list lands
  // behind it. Clicking in the frame the quote first exists is the only way to
  // be inside that window on every run: the seek page then merges before the
  // list has landed, and the tail draws the quoted row cut off at its top edge.
  // That row is not a landing.
  await page.addInitScript((href) => {
    const observer = new MutationObserver(() => {
      const link = document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
      if (!link) return;
      observer.disconnect();
      link.click();
    });
    observer.observe(document, { childList: true, subtree: true });
  }, `#message:${messageIdFor(MID_QUOTED_SEQUENCE)}`);
  // Not openChannel: the jump may leave the newest message before it is seen.
  await openGeneralChannelWithPagedHistory(page, history);

  await expectLandedOn(page, MID_QUOTED_SEQUENCE);
  await expectCentred(page, MID_QUOTED_SEQUENCE);
  await expect(page.locator(".app-message-timeline").getByText(NEWEST_BODY)).not.toBeInViewport();
});

test("clicking the same quote again mid-landing still lands", async ({ page }) => {
  const history = historyFixture({
    quotedSequence: MID_QUOTED_SEQUENCE,
    previewCarriesSequence: true,
  });
  await openChannel(page, history);

  // A reader who thinks the first click did nothing clicks again. The window
  // that matters is narrow and unreachable from outside the page: it opens one
  // frame after the seek page arrives, while the landing is still settling. In
  // it the second intent carries a new generation but the same URL hash, so
  // nothing about the hash can wake the effect - only a revision that always
  // changes can. Arming the second click from the seek response itself is the
  // only way to be inside that window on every run instead of by luck.
  const clicks = await page.evaluate(async (options) => {
    const preview = () => document.querySelector<HTMLAnchorElement>(`a[href="${options.href}"]`);
    const clicked: string[] = [];
    const secondClick = new Promise<void>((resolve) => {
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const target = args[0];
        const url = typeof target === "string" ? target : String((target as Request).url);
        if (!url.includes(options.seekQuery)) return response;
        window.fetch = originalFetch;
        requestAnimationFrame(() => {
          const link = preview();
          if (link) {
            link.click();
            clicked.push("settling");
          }
          resolve();
        });
        return response;
      };
    });
    preview()?.click();
    clicked.push("first");
    await secondClick;
    return clicked;
  }, {
    href: `#message:${messageIdFor(MID_QUOTED_SEQUENCE)}`,
    seekQuery: `beforeSequence=${MID_QUOTED_SEQUENCE + 1}`,
  });
  expect(clicks).toEqual(["first", "settling"]);

  await expectLandedOn(page, MID_QUOTED_SEQUENCE);
});

test("a reply preview without a sequence still reaches the quoted message", async ({ page }) => {
  const history = historyFixture({
    quotedSequence: HEAD_QUOTED_SEQUENCE,
    previewCarriesSequence: false,
  });
  await openChannel(page, history);
  await expect(messageRow(page, HEAD_QUOTED_SEQUENCE)).toHaveCount(0);

  await replyPreview(page, HEAD_QUOTED_SEQUENCE).click();

  // No sequence to seek with: the armed jump pages older history until the
  // quoted row exists rather than giving up silently.
  await expectLandedOn(page, HEAD_QUOTED_SEQUENCE);
});

test("a second click on the same quote jumps again", async ({ page }) => {
  const history = historyFixture({
    quotedSequence: HEAD_QUOTED_SEQUENCE,
    previewCarriesSequence: true,
  });
  await openChannel(page, history);

  await replyPreview(page, HEAD_QUOTED_SEQUENCE).click();
  await expectLandedOn(page, HEAD_QUOTED_SEQUENCE);

  const timeline = page.locator(".app-message-timeline");
  await timeline.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(page.locator(".app-message-timeline").getByText(NEWEST_BODY)).toBeVisible();

  // Every click arms its own jump. The URL hash left over from the first jump
  // must never be able to swallow the second one.
  await replyPreview(page, HEAD_QUOTED_SEQUENCE).click();
  await expectLandedOn(page, HEAD_QUOTED_SEQUENCE);
});
