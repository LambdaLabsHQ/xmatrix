import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_USER_SENDER,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

/* The agent work dock floats over the timeline and its scroller takes pointer
   events. The timeline pads its tail to clear it, and for a long time that pad
   was a constant while the dock's real footprint grew with each agent card. The
   shortfall always landed on the last message, whose hover-revealed controls sit
   at its bottom edge: pointing at a hover control hit the dock instead, so the
   button lost :hover, faded back to opacity 0, and could not be clicked. */

test.use(E2E_DESKTOP_CONTEXT);

const MESSAGE_COUNT = 30;

function agentPresence(agentCount: number) {
  const presence: Record<string, unknown> = {};
  for (let index = 0; index < agentCount; index += 1) {
    presence[`agent:codex-${index}`] = {
      kind: "agent",
      status: "busy",
      label: `Codex ${index}`,
      activity: "Reviewing hover controls",
      instances: [
        {
          id: `instance-codex-${index}`,
          channelInstanceId: `${index + 1}`,
          label: `codex:${index + 1}`,
          connectedAt: E2E_NOW,
          lastSeenAt: E2E_NOW,
          status: "busy",
          activity: "Reviewing hover controls",
          gitBranch: "fix/agent-work-dock-clearance",
        },
      ],
    };
  }
  return presence;
}

function messages() {
  return Array.from({ length: MESSAGE_COUNT }, (_unused, index) => ({
    messageId: `message-${index + 1}`,
    channelId: "channel-general",
    sequence: index + 1,
    body: `timeline body ${index + 1}`,
    sentAt: E2E_NOW,
    from: { ...E2E_USER_SENDER, identityId: "user:someone-else", userId: "someone-else" },
  }));
}

async function openChannelWithAgents(page: Page, agentCount: number, additionalChannels: unknown[] = []) {
  await openGeneralChannelWithHistory(
    page,
    {
      ...E2E_CHANNEL,
      messageCount: MESSAGE_COUNT,
      lastMessageSequence: MESSAGE_COUNT,
      updatedAt: E2E_NOW,
      memberPresence: agentPresence(agentCount),
    },
    messages(),
    additionalChannels
  );
  await expect(page.locator(".app-message-row").last()).toBeVisible();
  await expect(page.locator(".app-agent-work-scroller")).toBeVisible();
}

async function tailGeometry(page: Page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".app-message-row"));
    const lastRow = rows[rows.length - 1];
    const button = lastRow.querySelector<HTMLElement>('button[title="Add reaction"]');
    const scroller = document.querySelector<HTMLElement>(".app-agent-work-scroller");
    return {
      lastRowBottom: lastRow.getBoundingClientRect().bottom,
      button: button?.getBoundingClientRect().toJSON() ?? null,
      dockTop: scroller?.getBoundingClientRect().top ?? null,
    };
  });
}

// One agent leaves a narrow strip; several widen it past the whole button.
for (const agentCount of [1, 3]) {
  test(`the work dock stays clear of the last message with ${agentCount} online agent(s)`, async ({
    page,
  }) => {
    await openChannelWithAgents(page, agentCount);

    const rows = page.locator(".app-message-row");
    const lastRow = rows.last();
    await lastRow.hover();

    const geometry = await tailGeometry(page);
    expect(geometry.button).not.toBeNull();
    // The dock must begin below the message it would otherwise cover.
    expect(geometry.dockTop).toBeGreaterThan(geometry.lastRowBottom);

    // Walk the pointer across the button: it must stay revealed the whole way,
    // which is what the pointer-eating overlay used to break.
    const button = geometry.button!;
    const centerY = button.top + button.height / 2;
    for (let x = button.left + 4; x < button.right - 4; x += 12) {
      await page.mouse.move(x, centerY);
      const state = await page.evaluate(
        ([pointerX, pointerY]) => {
          const rows = Array.from(document.querySelectorAll<HTMLElement>(".app-message-row"));
          const last = rows[rows.length - 1];
          const target = last.querySelector<HTMLElement>('button[title="Add reaction"]');
          const hit = document.elementFromPoint(
            pointerX as number,
            pointerY as number
          ) as HTMLElement | null;
          return {
            opacity: target ? getComputedStyle(target).opacity : null,
            overDock: Boolean(hit?.closest(".app-agent-work-dock")),
          };
        },
        [x, centerY]
      );
      expect(state, `pointer at x=${x} over the last message's hover control`).toEqual({
        opacity: "1",
        overDock: false,
      });
    }

  });
}

test("a composer that grows pushes the dock up and the timeline tail with it", async ({ page }) => {
  await openChannelWithAgents(page, 3);

  const composer = page.locator(".app-composer");
  const before = await composer.boundingBox();
  const beforeGeometry = await tailGeometry(page);
  expect(beforeGeometry.dockTop).toBeGreaterThan(beforeGeometry.lastRowBottom);

  // Grow the composer. The dock is anchored to --app-composer-height in CSS, so
  // it rides upward without ever changing its own size -- the case where every
  // ResizeObserver stays silent and a published measurement would go stale.
  const textarea = page.locator(".composer-textarea");
  await textarea.fill(Array.from({ length: 10 }, (_unused, line) => `draft line ${line}`).join("\n"));
  await expect
    .poll(async () => (await composer.boundingBox())?.height ?? 0)
    .toBeGreaterThan((before?.height ?? 0) + 20);

  /* A grown composer is not yet a moved dock. The box grows first; the write to
     --app-composer-height that actually relocates the dock happens in the
     composer's own ResizeObserver callback, one delivery later. Sampling
     geometry here reads the pre-move position. Wait for the move itself. */
  await expect
    .poll(async () => (await tailGeometry(page)).dockTop ?? Number.POSITIVE_INFINITY)
    .toBeLessThan(beforeGeometry.dockTop!);

  /* Only now is the regression guard meaningful: the dock has ridden up, and
     the tail has to have followed. Poll the margin rather than a single sample
     so a mid-relayout frame cannot decide the verdict either way. Without the
     fix this margin sits at -91px and never converges. */
  await expect
    .poll(async () => {
      const geometry = await tailGeometry(page);
      return (geometry.dockTop ?? Number.NEGATIVE_INFINITY) - geometry.lastRowBottom;
    })
    .toBeGreaterThan(0);

  const lastRow = page.locator(".app-message-row").last();
  await lastRow.hover();
  const button = (await tailGeometry(page)).button!;
  const overDock = await page.evaluate(
    ([pointerX, pointerY]) => {
      const hit = document.elementFromPoint(
        pointerX as number,
        pointerY as number
      ) as HTMLElement | null;
      return Boolean(hit?.closest(".app-agent-work-dock"));
    },
    [button.left + button.width / 2, button.top + button.height / 2]
  );
  expect(overDock).toBe(false);
});

/* A completion panel (@, /, [[, #) grows the composer box upward, over the
   timeline. It is a popup: if its height reached --app-composer-height, the
   timeline would pad its tail by it and shove every message up while you pick.
   They share one box, so a # channel reference stands in for all of them. */
test("a completion panel covers the timeline instead of pushing it up", async ({ page }) => {
  await openChannelWithAgents(page, 3, [
    { ...E2E_CHANNEL, id: "5f0c2d4e-8a1b-4c3d-9e2f-1a2b3c4d5e6f", name: "release-train" },
  ]);
  const beforeGeometry = await tailGeometry(page);
  const composer = page.locator(".app-composer");
  const before = await composer.boundingBox();

  await page.locator(".composer-textarea").fill("ship in #rel");
  await expect(page.getByTestId("composer-reference-suggestions")
    .getByRole("option", { name: /release-train/u })).toBeVisible();
  await expect
    .poll(async () => (await composer.boundingBox())?.height ?? 0)
    .toBeGreaterThan((before?.height ?? 0) + 40);
  await expect(page.locator(".app-composer-box-morphing")).toHaveCount(0);

  const open = await tailGeometry(page);
  expect(open.lastRowBottom).toBeCloseTo(beforeGeometry.lastRowBottom, 0);
  expect(open.dockTop).toBeCloseTo(beforeGeometry.dockTop!, 0);

  // Closing the panel re-measures the resting composer, which never changed.
  await page.locator(".composer-textarea").fill("");
  await expect(page.locator(".app-mention-suggestions")).toHaveCount(0);
  await expect(page.locator(".app-composer-box-morphing")).toHaveCount(0);
  await expect
    .poll(async () => (await tailGeometry(page)).lastRowBottom)
    .toBeCloseTo(beforeGeometry.lastRowBottom, 0);
});
