import { expectDraft } from "./composer-draft";
import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRule } from "./in-page-api-fixtures";
import { paintedRowMoves, paintedRowOverlaps, paintedTimelineFrames, recordPaintedTimelineFrames } from "./painted-timeline-frames";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  E2E_USER_SENDER,
  channelHistoryFixture,
  conversationOpened,
  fixtureChannelCatalog,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

/* Sending a message used to move the whole timeline in one frame. The new row
   now rises out of the composer and the rows above rise with it, the way a
   chat app's list moves on send (user 2026-10-10: "发送消息的时候，我们有个上浮动画，
   就像微信一样吧"). The motion is over in a quarter of a second, so the spec reads
   the animations the page started rather than sampling positions mid-flight. */

test.use(E2E_DESKTOP_CONTEXT);

type Page = Parameters<Parameters<typeof test>[2]>[0]["page"];
type Rise = { sent: boolean; fromPx: number; fades: boolean };
/** A way to rest the list was given to the compositor: where from, how long, and whether it only slows towards rest. */
type ListRise = { fromPx: number; durationMs: number; oneWay: boolean; slowing: boolean };
/** A way to rest as handed to the compositor: the list's offsets at even steps, and when it set off on the document's clock. */
type ListWay = { offsets: number[]; durationMs: number; startMs: number };

const HISTORY_LENGTH = 40;
const SENT_BODY = "Rising message";

const AUTHORITY = { protocolVersion: 1, contentRevision: 1 };

/** #general as the catalog lists it when it holds `messages` messages. */
function channelAt(messages: number) {
  return {
    ...E2E_CHANNEL, updatedAt: E2E_NOW, messageCount: messages, lastMessageSequence: messages,
    historyHeadSequence: messages, contentAuthority: AUTHORITY,
  };
}

async function openChannelRecordingRises(page: Page) {
  await page.addInitScript(() => {
    const rises: Rise[] = [];
    const listRises: ListRise[] = [];
    (window as unknown as { __timelineRises: Rise[] }).__timelineRises = rises;
    (window as unknown as { __timelineListRises: ListRise[] }).__timelineListRises = listRises;
    const ways: ListWay[] = [];
    (window as unknown as { __listWays: ListWay[] }).__listWays = ways;
    /* Each time the list was held still, without a way to rest, after it had
       already set off on one: the way it was going stopped dead. */
    const stops: string[] = [];
    let travelling = false;
    (window as unknown as { __listStops: string[] }).__listStops = stops;
    (window as unknown as { __listAtRestBeforeSend: () => void }).__listAtRestBeforeSend = () => {
      travelling = false;
      stops.length = 0;
      ways.length = 0;
    };
    new MutationObserver((records) => {
      for (const { target } of records) {
        const list = target as HTMLElement;
        if (!list.hasAttribute?.("data-timeline-rise-content")) continue;
        if (travelling && list.style.translate !== "" && list.getAnimations().length === 0) stops.push(list.style.translate);
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["style"] });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function recordRise(this: Element, keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      const kind = this.getAttribute("data-timeline-rise-row");
      const first = Array.isArray(keyframes) ? keyframes[0] : undefined;
      const from = /translateY\(([\d.]+)px\)/u.exec(String(first?.transform ?? ""));
      if (kind !== null && from) {
        rises.push({ sent: kind === "sent", fromPx: Number(from[1]), fades: first?.opacity === 0 });
      }
      // The list's own way to rest: the offsets the compositor draws it at, in order.
      if (this.hasAttribute("data-timeline-rise-content") && Array.isArray(keyframes)) {
        travelling = true;
        const offsets = keyframes.map((frame) => Number(/^0 (-?[\d.]+)px$/u.exec(String(frame.translate ?? ""))?.[1]));
        const steps = offsets.slice(1).map((offset, index) => Math.abs(offsets[index]!) - Math.abs(offset));
        const listed = { offsets, durationMs: Number(typeof options === "number" ? options : options?.duration), startMs: NaN };
        ways.push(listed);
        // When it set off; one replaced before the compositor started it never moved the list.
        void animation.ready.then(() => { listed.startMs = Number(animation.startTime ?? NaN); }, () => undefined);
        listRises.push({
          fromPx: offsets[0]!,
          durationMs: listed.durationMs,
          oneWay: offsets.every(Number.isFinite) && offsets.at(-1) === 0 && steps.every((step) => step >= 0),
          slowing: steps[0]! > steps.at(-1)!,
        });
      }
      return animation;
    };
  });
  await openGeneralChannelWithHistory(page, channelAt(HISTORY_LENGTH), channelHistoryFixture(HISTORY_LENGTH, "rise"));
  await fixtureJson(page, "send-rise", "**/api/xmatrix/channels/channel-general/messages",
    { message: {
      messageId: "sent-rise", channelId: E2E_CHANNEL.id, sequence: HISTORY_LENGTH + 1, body: SENT_BODY,
      sentAt: new Date().toISOString(), from: { ...E2E_USER_SENDER, identityId: "user:e2e-user" },
    } }, { method: "POST" });
  await expect(page.locator(".app-message-row").filter({ hasText: `Message ${HISTORY_LENGTH}.` })).toBeVisible();
  await conversationOpened(page);
}

async function sendAndReadRises(page: Page): Promise<Rise[]> {
  const draft = page.locator(".composer-textarea").first();
  await draft.fill(SENT_BODY);
  await draft.press("Enter");
  await expect(page.locator(".app-message-row").filter({ hasText: SENT_BODY })).toBeInViewport();
  return page.evaluate(() => (window as unknown as { __timelineRises: Rise[] }).__timelineRises);
}

/**
 * Every way to rest the list has been given so far. The compositor draws it,
 * so how many of its frames the page itself sees depends on how busy the page
 * is; what the compositor was told to draw does not.
 */
async function listRises(page: Page): Promise<ListRise[]> {
  return page.evaluate(() => (window as unknown as { __timelineListRises: ListRise[] }).__timelineListRises.slice());
}

/** Each of them goes one way; one that travels a row's room slows as it arrives and takes long enough to be seen. */
function expectDrawnRises(rises: readonly ListRise[], atLeast: number) {
  const travels = rises.filter((rise) => Math.abs(rise.fromPx) >= 8);
  expect(travels.length, JSON.stringify(rises)).toBeGreaterThanOrEqual(atLeast);
  expect(rises.filter((rise) => !rise.oneWay)).toEqual([]);
  for (const rise of travels) {
    expect(rise.slowing, JSON.stringify(rise)).toBe(true);
    expect(rise.durationMs).toBeGreaterThan(100);
  }
}

/** The list stands in its place: nothing holds it lower, and nothing is still bringing it there. */
async function listAtRest(page: Page) {
  await expect.poll(() => page.locator(".app-message-timeline [data-timeline-rise-content]").evaluate((list) =>
    (list as HTMLElement).style.translate === "" && list.getAnimations().length === 0)).toBe(true);
}

/** The frames painted so far, once no row is still coming in and the list stands in its place. */
async function framesOnceAtRest(page: Page) {
  await expect.poll(() => page.locator(".app-message-timeline [data-timeline-rise-row]").evaluateAll((rows) =>
    rows.filter((row) => row.getAnimations().length > 0).length)).toBe(0);
  await listAtRest(page);
  return paintedTimelineFrames(page);
}

/** The frames painted while `send` plays out, once the rows stand still again. */
async function framesOfSend(page: Page, send: () => Promise<void>) {
  await recordPaintedTimelineFrames(page);
  await send();
  return framesOnceAtRest(page);
}

/** How far, frame by frame, the newest message of the history moved. */
function movesOfRowAbove(frames: Awaited<ReturnType<typeof paintedTimelineFrames>>) {
  return paintedRowMoves(frames).filter((move) => move.row === `message:rise-${HISTORY_LENGTH}`).map((move) => move.by);
}

test("the new row comes in and the list comes to rest in the same frame", async ({ page }) => {
  await openChannelRecordingRises(page);
  // When each of the two animations ends, on the document's clock: the row's
  // own way up, and the list's way to rest. Ending apart, each would wake the
  // page ahead of its end and lay its layers out again once it is over.
  // Read in the page on every frame from before the send: the two run together
  // for only part of a third of a second, which a busy page's round trips miss.
  await page.evaluate(() => {
    const aparts: number[] = [];
    (window as unknown as { __riseEndsApart: number[] }).__riseEndsApart = aparts;
    const read = () => {
      const list = document.querySelector(".app-message-timeline [data-timeline-rise-content]");
      const row = Array.from(document.querySelectorAll(".app-message-timeline [data-timeline-rise-row='sent']")).at(-1);
      const [rise] = list?.getAnimations() ?? [];
      const [entrance] = row?.getAnimations() ?? [];
      if (rise?.effect && entrance?.effect && rise.startTime !== null && entrance.startTime !== null) {
        const end = (animation: Animation) => Number(animation.startTime) + Number(animation.effect!.getComputedTiming().endTime);
        aparts.push(Math.abs(end(rise) - end(entrance)));
      }
      requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  });
  await sendAndReadRises(page);
  await listAtRest(page);
  const aparts = await page.evaluate(() => (window as unknown as { __riseEndsApart: number[] }).__riseEndsApart);
  expect(aparts.length).toBeGreaterThan(0);
  expect(aparts.at(-1)).toBeLessThan(1);
});

test("a sent message rises from the composer and lifts the rows above it", async ({ page }) => {
  await openChannelRecordingRises(page);
  let rises: Rise[] = [];
  const frames = await framesOfSend(page, async () => {
    rises = await sendAndReadRises(page);
  });
  const moves = movesOfRowAbove(frames);

  expect(rises).toEqual([{ sent: true, fromPx: expect.any(Number), fades: true }]);
  // The rows above travel the room the new row took: up from where they
  // stood, slower as they arrive, and what was painted of it never went back.
  expectDrawnRises(await listRises(page), 1);
  expect((await listRises(page))[0]!.fromPx).toBeGreaterThan(0);
  expect(moves.length).toBeGreaterThan(0);
  expect(moves.filter((by) => by > 0)).toEqual([]);
  // The rows move visually; the viewport the virtualizer measures retains
  // its place in the layout, so a scroll cannot feed the rise back as an offset.
  const viewportOffsets = frames.flatMap((frame) => frame.viewportOffsetTop === null ? [] : [frame.viewportOffsetTop]);
  expect(viewportOffsets.length).toBeGreaterThan(1);
  expect(Math.max(...viewportOffsets) - Math.min(...viewportOffsets)).toBeLessThan(1);
});

/* The list makes room for a new row by an estimate and corrects it a frame
   later. For a short row under the sender's last one the estimate is too
   large: the rows were lifted too far and came back, like a spring
   (user 2026-10-10: "整个消息页面会往上弹一下然后弹回来，像弹簧"). */
test("messages sent one after another lift the rows without a bounce", async ({ page }) => {
  await openChannelRecordingRises(page);
  const draft = page.locator(".composer-textarea").first();
  for (const [index, body] of ["One", "Two", "Three"].entries()) {
    await answerNextSend(page, HISTORY_LENGTH + 1 + index, body, 150);
    const moves = movesOfRowAbove(await framesOfSend(page, async () => {
      await draft.fill(body);
      await draft.press("Enter");
      await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 1 + index}"]`)).toBeInViewport();
    }));
    expectDrawnRises(await listRises(page), index + 1);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.filter((by) => by > 0)).toEqual([]);
  }
});

/* Every message that comes in is a new row at the end, whoever wrote it
   (user 2026-10-10: "我想让 agent 发的消息也有这个动态效果，或者说所有新消息都有这个效果"). */
test("a message from someone else comes in the same way", async ({ page }) => {
  await openChannelRecordingRises(page);
  const arrived = { ...channelHistoryFixture(HISTORY_LENGTH + 1, "rise")[HISTORY_LENGTH]!,
    body: "An Agent's report, just in.", from: { ...E2E_USER_SENDER, identityId: "user:someone-else", userId: "someone-else", label: "Someone" } };
  const moves = movesOfRowAbove(await framesOfSend(page, async () => {
    await fixtureChannelCatalog(page, "catalog-arrived", [channelAt(HISTORY_LENGTH + 1)]);
    await fixtureJson(page, "history-arrived", "**/api/xmatrix/channels/channel-general/history**",
      { messages: [arrived], hasMore: false, historyHeadSequence: HISTORY_LENGTH + 1, contentAuthority: AUTHORITY });
    await page.evaluate((spaceId) => window.dispatchEvent(new CustomEvent(
      "xmatrix:channel-catalog-change", { detail: { spaceId, kind: "structure" } },
    )), E2E_SPACE.id);
    await expect(page.locator(`[id="message:rise-${HISTORY_LENGTH + 1}"]`)).toBeInViewport();
  }));
  expectDrawnRises(await listRises(page), 1);
  expect(moves.length).toBeGreaterThan(0);
  expect(moves.filter((by) => by > 0)).toEqual([]);
});

/* A message that comes in while the last one is still rising goes on from
   where the rows are drawn. The rows used to be offset one by one, and a row
   the list mounted meanwhile stood apart from them: messages were drawn over
   each other (user 2026-10-13: "这个渲染怎么回事"). */
test("messages that come in while the rows are rising are never drawn over each other", async ({ page }) => {
  await openChannelRecordingRises(page);
  const draft = await sendOneAndDraftTwo(page);
  await draft.press("Enter");
  await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 2}"]`)).toBeInViewport();
  const frames = await framesOnceAtRest(page);
  expect(frames.length).toBeGreaterThan(10);
  expect(paintedRowOverlaps(frames)).toEqual([]);
});

/** Resolves once the compositor is drawing the list to rest, with what it has drawn so far (ms). */
async function listOnItsWayToRest(page: Page): Promise<number> {
  const handle = await page.waitForFunction(() => {
    const list = document.querySelector(".app-message-timeline [data-timeline-rise-content]");
    const [rise] = list?.getAnimations() ?? [];
    return rise?.playState === "running" && Number(rise.currentTime) > 30 ? Number(rise.currentTime) : false;
  }, undefined, { polling: "raf" });
  return handle.jsonValue() as Promise<number>;
}

/* The way to rest is the compositor's: the page only knows how far it has come
   from the animation's own clock. A message that arrives then has to go on
   from where the list is drawn at that moment, not from where the first rise
   began and not from its place in the layout. */
test("a message that comes in while the list is on its way to rest goes on from where it is drawn", async ({ page }) => {
  await openChannelRecordingRises(page);
  const draft = await sendOneAndDraftTwo(page);
  expect(await listOnItsWayToRest(page)).toBeGreaterThan(30);
  await draft.press("Enter");
  await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 2}"]`)).toBeInViewport();
  const frames = await framesOnceAtRest(page);
  const moves = movesOfRowAbove(frames);
  // The rows go on rising, both messages' room in all. No frame throws the
  // list to its place or back to where it stood: the only way down is the few
  // pixels by which a late correction of the layout settles, as after any send.
  const travelled = Math.abs(moves.reduce((sum, by) => sum + by, 0));
  // Two ways to rest were given: the first, and the one that took over from where it had come.
  expectDrawnRises(await listRises(page), 2);
  expect(moves.filter((by) => by < 0).length).toBeGreaterThan(1);
  expect(Math.max(...moves.map((by) => Math.abs(by)))).toBeLessThan(travelled * 0.6);
  expect(Math.max(0, ...moves)).toBeLessThan(8);
  expect(paintedRowOverlaps(frames)).toEqual([]);
});

/* The reader's own scrolling is theirs. While the list is on its way to rest
   a wheel takes it at once: nothing is still drawn lower, nothing clips the
   list, and nothing brings the reader back to the newest message afterwards. */
test("the reader's wheel takes the list from a rise that is still playing", async ({ page }) => {
  await openChannelRecordingRises(page);
  const draft = page.locator(".composer-textarea").first();
  const timeline = page.locator(".app-message-timeline");
  await answerNextSend(page, HISTORY_LENGTH + 1, "One", 150);
  await draft.fill("One");
  const box = (await timeline.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await draft.press("Enter");
  await listOnItsWayToRest(page);
  await page.mouse.wheel(0, -400);
  const state = () => timeline.evaluate((scroller) => {
    const list = scroller.querySelector<HTMLElement>("[data-timeline-rise-content]")!;
    return {
      held: list.style.translate !== "" || list.getAnimations().length > 0 || list.parentElement!.style.overflow !== "",
      fromEnd: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
    };
  });
  await expect.poll(async () => (await state()).held).toBe(false);
  await expect.poll(async () => (await state()).fromEnd).toBeGreaterThan(200);
  const away = (await state()).fromEnd;
  // Past the time a late correction of the layout is still waited for.
  await page.waitForTimeout(1_800);
  expect(await state()).toEqual({ held: false, fromEnd: away });
});

test("a sent message lands without motion when the reader asked for less of it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openChannelRecordingRises(page);
  expect(await sendAndReadRises(page)).toEqual([]);
});

/* What the server answers a send with, after `delayMs`: long enough for a spec
   to look at the row while it is still on its way. */
async function answerNextSend(page: Page, sequence: number, body: string, delayMs: number) {
  await answerSends(page, sequence, [body], delayMs);
}

/** The answers to the next sends, in the order they are made, the first as message `sequence`. */
async function answerSends(page: Page, sequence: number, bodies: readonly string[], delayMs: number) {
  await fixtureRule(page, {
    id: `send-held-${sequence}`,
    pattern: "**/api/xmatrix/channels/channel-general/messages",
    method: "POST",
    responder: { kind: "sequence", delayMs, responses: bodies.map((body, index) => ({ json: { message: {
      messageId: `held-${sequence + index}`, channelId: E2E_CHANNEL.id, sequence: sequence + index, body,
      sentAt: new Date().toISOString(), from: { ...E2E_USER_SENDER, identityId: "user:e2e-user" },
    } } })) },
  });
}

/** Sends "One" while recording painted frames, and drafts a longer second message to send after it. */
async function sendOneAndDraftTwo(page: Page) {
  const draft = page.locator(".composer-textarea").first();
  /* Both answers in one rule, in order: given as two, the later one takes over
     the route, the first send comes back as the second message, and the
     second send's row folds into it as the list rests. */
  await answerSends(page, HISTORY_LENGTH + 1, ["One", "Two, which is a longer message than the one before it."], 150);
  await recordPaintedTimelineFrames(page);
  await draft.fill("One");
  await draft.press("Enter");
  await draft.fill("Two, which is a longer message than the one before it.");
  return draft;
}

/** The newest row's height, whether it starts a sender's turn, and its avatar node. */
async function newestRowShape(page: Page, markAvatar: boolean) {
  return page.locator(".app-message-timeline [data-timeline-rise-row]").last().evaluate((row, mark) => {
    const avatar = row.querySelector<HTMLElement>(".identity-avatar");
    const sameAvatar = avatar?.dataset.pendingAvatar === "kept";
    if (avatar && mark) avatar.dataset.pendingAvatar = "kept";
    return {
      height: Math.round(row.getBoundingClientRect().height),
      header: Boolean(row.querySelector(".app-message-author-name")),
      sameAvatar,
    };
  }, markAvatar);
}

/* The row a send adds is the row the server's copy will be. It used to be
   drawn apart from the sender's turn, with an avatar and a name of its own,
   and without the hover actions beside the name: when the server confirmed it
   the header vanished, the row lost a third of its height or gained four
   pixels, and every message above moved in that frame
   (user 2026-10-10: "我发现发完消息还是会闪烁？"). */
test("a message on its way is drawn as it will be once the server has it", async ({ page }) => {
  await openChannelRecordingRises(page);
  const draft = page.locator(".composer-textarea").first();

  await answerNextSend(page, HISTORY_LENGTH + 1, "First of two", 1_500);
  await draft.fill("First of two");
  await draft.press("Enter");
  const sending = page.locator(".app-message-sending");
  await expect(sending).toHaveCount(1);
  // A send answered at once never shows the mark: it waits before it appears.
  expect(await sending.evaluate((mark) => mark.getAnimations()
    .map((animation) => animation.effect?.getTiming().delay))).toEqual([700]);
  const first = await newestRowShape(page, true);
  expect(first.header).toBe(true);
  await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 1}"]`)).toBeVisible();
  await expect(sending).toHaveCount(0);
  expect(await newestRowShape(page, false)).toEqual({ ...first, sameAvatar: true });

  // Moments later, under the first: no second header, before or after.
  await answerNextSend(page, HISTORY_LENGTH + 2, "Second of two", 1_500);
  await draft.fill("Second of two");
  await draft.press("Enter");
  await expect(sending).toHaveCount(1);
  const second = await newestRowShape(page, false);
  expect(second.header).toBe(false);
  await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 2}"]`)).toBeVisible();
  expect(await newestRowShape(page, false)).toEqual(second);
});

/* A draft of several lines gives its lines back when it is sent: the composer
   shrinks, and the timeline's end comes down with it a frame or two after the
   new row is in. The rows above used to drop by that much in one frame, in the
   middle of their rise. Every move is part of the rise now. */
test("a draft of several lines is sent without the rows above dropping", async ({ page }) => {
  await openChannelRecordingRises(page);
  const body = ["One", "Two", "Three", "Four", "Five"].map((line) => `Line ${line}`).join("\n");
  await answerNextSend(page, HISTORY_LENGTH + 1, body, 150);
  const draft = page.locator(".composer-textarea").first();
  await draft.fill(body);
  await expectDraft(draft, body);

  const frames = await framesOfSend(page, async () => {
    await draft.press("Enter");
    await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 1}"]`)).toBeInViewport();
  });
  // One correction of the list's estimate can still land a frame late: a few
  // pixels for one frame, where the rows used to drop by the composer's lines.
  const dropped = movesOfRowAbove(frames).filter((by) => by > 0).reduce((sum, by) => sum + by, 0);
  expect(dropped).toBeLessThan(8);
  const above = `message:rise-${HISTORY_LENGTH}`;
  expect(frames[frames.length - 1]!.tops[above]).toBeLessThan(frames[0]!.tops[above]!);
});

/**
 * Each hand-over from one way to rest to the next while the list was moving,
 * at which the speed it was drawn at changed by more than the spring's own
 * change over one piece of it (px/ms).
 */
function speedChangesAtHandOvers(ways: readonly ListWay[]): string[] {
  const speedOf = (way: ListWay, at: number) => {
    const step = way.durationMs / (way.offsets.length - 1);
    const piece = Math.min(way.offsets.length - 2, Math.max(0, Math.floor((at - way.startMs) / step)));
    return (way.offsets[piece + 1]! - way.offsets[piece]!) / step;
  };
  const started = ways.filter((way) => Number.isFinite(way.startMs));
  expect(started.length).toBeGreaterThan(1);
  return started.slice(1).flatMap((way, index) => {
    const before = started[index]!;
    if (way.startMs >= before.startMs + before.durationMs) return [];
    const was = speedOf(before, way.startMs);
    const is = speedOf(way, way.startMs);
    return Math.abs(is - was) > 0.25 ? [`${was.toFixed(3)} -> ${is.toFixed(3)} at ${Math.round(way.startMs - started[0]!.startMs)} ms`] : [];
  });
}

/* The layout reaches the new row's place in steps: here the server's copy of
   the message, a line longer than the draft, lands while the rows are still
   rising. The rows used to stop dead at each step and set off again at full
   speed, and a step after they had stopped set them off once more (user
   2026-10-24: "挺住了之后，还会有轻微的小抖动，那个运动曲线有问题。数学上就不太对").
   A step now changes where they are going, never how fast they were going. */
test("a step of the layout on the way keeps the rows moving as fast as they were", async ({ page }) => {
  await openChannelRecordingRises(page);
  await answerNextSend(page, HISTORY_LENGTH + 1, "Short one\n\nand a line the server's copy has", 120);
  const draft = page.locator(".composer-textarea").first();
  await draft.fill("Short one");
  await page.evaluate(() => (window as unknown as { __listAtRestBeforeSend: () => void }).__listAtRestBeforeSend());
  const frames = await framesOfSend(page, async () => {
    await draft.press("Enter");
    await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 1}"]`)).toContainText("and a line");
  });
  // The row's own copy took more room, so the rows above went on further.
  const rises = await listRises(page);
  expect(rises.length, JSON.stringify(rises)).toBeGreaterThan(1);
  expectDrawnRises(rises, 1);
  expect(await page.evaluate(() => (window as unknown as { __listStops: string[] }).__listStops)).toEqual([]);
  expect(speedChangesAtHandOvers(await page.evaluate(() => (window as unknown as { __listWays: ListWay[] }).__listWays)))
    .toEqual([]);
  expect(movesOfRowAbove(frames).filter((by) => by > 0)).toEqual([]);
});

/* The end of the timeline can still change once a send's rise is over: the
   server's copy laid out differently, the work dock coming or going, a chip.
   The reader stays on the newest message, and the rows used to get there in
   one frame (user 2026-10-24: "现在看起来像是状态在变化…和卡片的那个idle，还有
   Busy是相关的"). They go there along the rise's spring now, either way. */
for (const { change, answer } of [
  { change: "grows", answer: "Late one\n\nwith a line that came later\n\nand another" },
  { change: "shrinks", answer: "Late" },
]) {
  test(`the end of the timeline that ${change} after the rise is over moves the rows along the way`, async ({ page }) => {
    await openChannelRecordingRises(page);
    const draft = page.locator(".composer-textarea").first();
    const body = "Late one\n\nwith a line";
    await answerNextSend(page, HISTORY_LENGTH + 1, answer, 3_500);
    await draft.fill(body);
    await draft.press("Enter");
    await listAtRest(page);
    // Past the rise: the timeline stands still on its newest message.
    await page.waitForTimeout(1_700);
    await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 1}"]`)).toHaveCount(0);
    const frames = await framesOfSend(page, async () => {
      await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 1}"]`)).toBeVisible({ timeout: 5_000 });
    });
    const moves = movesOfRowAbove(frames);
    const travelled = Math.abs(moves.reduce((sum, by) => sum + by, 0));
    expect(travelled, JSON.stringify(moves)).toBeGreaterThan(8);
    // One way, over several frames, none of them most of the way.
    expect(moves.every((by) => Math.sign(by) === Math.sign(moves[0]!)), JSON.stringify(moves)).toBe(true);
    expect(Math.max(...moves.map((by) => Math.abs(by))), JSON.stringify(moves)).toBeLessThan(travelled * 0.5);
  });
}
