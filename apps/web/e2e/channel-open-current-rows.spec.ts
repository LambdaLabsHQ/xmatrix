import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_MOBILE_CONTEXT,
  E2E_SPACE,
  E2E_USER_SENDER,
  conversationOpened,
  fixtureChannelCatalog,
  fixtureJson,
  fixtureRequests,
  installWorkspaceStubs,
  routeHumanSocket,
} from "./workspace-fixtures";

/* A conversation opens on the rows it keeps showing. It used to open on what
   this client last held of it and rearrange them a moment later, when its
   latest page arrived (user 2026-10-15: "点开频道有时候会闪一下…有时候会有旧消息"):
   on a phone back from the background the messages sent meanwhile came in
   under the old screen. Every painted frame of the open is read. */

const authority = { protocolVersion: 1, contentRevision: 1 };
const OTHER = { ...E2E_CHANNEL, id: "channel-other", name: "other" };

function message(sequence: number, extra: Record<string, unknown> = {}) {
  return {
    messageId: `other-${sequence}`, channelId: OTHER.id, sequence, from: E2E_USER_SENDER,
    body: `Other message ${sequence}`, sentAt: new Date(Date.now() - (60 - sequence) * 60_000).toISOString(),
    reactions: [], annotations: [], attachments: [], ...extra,
  };
}

const catalogAt = (head: number) => [
  { ...E2E_CHANNEL, updatedAt: new Date().toISOString(), messageCount: 1, historyHeadSequence: 1,
    contentAuthority: authority },
  { ...OTHER, updatedAt: new Date(Date.now() - 1_000).toISOString(), messageCount: head,
    historyHeadSequence: head, contentAuthority: authority },
];

async function serveOther(page: Page, id: string, messages: unknown[]) {
  await fixtureJson(page, id, `**/api/xmatrix/channels/${OTHER.id}/history**`, {
    messages, hasMore: false, historyHeadSequence: messages.length, contentAuthority: authority,
  });
}

/** Opens #general and waits until the list's other conversation has been read ahead. */
async function openGeneralWithOtherHeld(page: Page, otherMessages: unknown[], rule: string) {
  let send: ((frame: unknown) => void) | undefined;
  await routeHumanSocket(page, (frame, reply) => { if (frame.type === "human_connect") send = reply; });
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: catalogAt(otherMessages.length) });
  await fixtureJson(page, "general-history", `**/api/xmatrix/channels/${E2E_CHANNEL.id}/history**`, {
    messages: [{ ...message(1), messageId: "general-1", channelId: E2E_CHANNEL.id, body: "General message" }],
    hasMore: false, historyHeadSequence: 1, contentAuthority: authority,
  });
  await serveOther(page, rule, otherMessages);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-message-timeline").getByText("General message")).toBeVisible();
  await expect.poll(() => Boolean(send)).toBe(true);
  await expect.poll(async () => (await fixtureRequests(page, rule)).length).toBeGreaterThan(0);
  return (frame: unknown) => send!(frame);
}

/** What the timeline shows in every frame painted from now on. */
async function recordTimelineText(page: Page) {
  await page.evaluate(() => {
    const frames: string[] = [];
    (window as Window & { __timelineText?: string[] }).__timelineText = frames;
    const painted = new MessageChannel();
    painted.port1.onmessage = () => {
      const timeline = document.querySelector<HTMLElement>(".app-message-timeline");
      if (timeline) frames.push(timeline.innerText);
    };
    const eachFrame = () => {
      painted.port2.postMessage(null);
      requestAnimationFrame(eachFrame);
    };
    requestAnimationFrame(eachFrame);
  });
}

async function timelineTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as Window & { __timelineText?: string[] }).__timelineText ?? []);
}

test.describe("phone", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("a conversation the list shows newer messages for opens on them", async ({ page }) => {
    const held = Array.from({ length: 6 }, (_, index) => message(index + 1));
    await openGeneralWithOtherHeld(page, held, "other-held");
    await page.getByRole("button", { name: "Back to channels" }).tap();

    // The socket delivered nothing while two messages were sent (an iOS
    // WebView back from the background); the list's next read shows them.
    const current = Array.from({ length: 8 }, (_, index) => message(index + 1));
    await serveOther(page, "other-current", current);
    await fixtureChannelCatalog(page, "catalog-8", catalogAt(8));
    await page.evaluate((spaceId) => window.dispatchEvent(new CustomEvent(
      "xmatrix:channel-catalog-change", { detail: { spaceId, kind: "structure" } },
    )), E2E_SPACE.id);
    await expect.poll(async () => (await fixtureRequests(page, "other-current")).length).toBeGreaterThan(0);

    await recordTimelineText(page);
    await page.locator(`[data-mobile-channel-row-id="${OTHER.id}"]`).tap();
    await expect(page.locator(".app-message-timeline").getByText("Other message 8", { exact: true })).toBeVisible();
    await conversationOpened(page);
    const open = (await timelineTexts(page)).filter((text) => text.includes("Other message"));
    expect(open.length).toBeGreaterThan(0);
    // The newest message is there from the first frame the conversation shows.
    expect(open.filter((text) => !text.includes("Other message 8"))).toEqual([]);
  });
});
