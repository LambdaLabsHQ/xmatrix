import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { fixtureJson } from "./in-page-api-fixtures";
import { E2E_CHANNEL, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

const EMPTY_COMPOSER_PASTE_SENTINEL = "\u200B";
const E2E_RANDOM_CHANNEL = {
  ...E2E_CHANNEL,
  id: "channel-random",
  name: "random",
};

async function expectEmptyComposerCaret(textarea: Locator) {
  await expect
    .poll(async () =>
      textarea.evaluate((node) => ({
        active: document.activeElement === node,
        selectionStart: node.selectionStart,
        selectionEnd: node.selectionEnd,
        value: node.value,
      }))
    )
    .toEqual({
      active: true,
      selectionStart: 0,
      selectionEnd: 0,
      value: EMPTY_COMPOSER_PASTE_SENTINEL,
    });
}

async function openTwoChannelWorkspace(page: Page) {
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [E2E_CHANNEL, E2E_RANDOM_CHANNEL],
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");

  const textarea = page.locator("textarea.composer-textarea").first();
  await expect(textarea).toBeVisible();
  return textarea;
}

test("first tap on an empty composer shell shows a collapsed caret instead of selecting the paste sentinel", async ({
  page,
}) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");

  const composerBox = page.locator(".app-composer-box").first();
  const textarea = page.locator("textarea.composer-textarea").first();
  await expect(textarea).toBeVisible();

  const box = await composerBox.boundingBox();
  expect(box).not.toBeNull();
  // The capsule's controls sit inside it, so tap its top padding, clear of them.
  await composerBox.tap({ position: { x: Math.floor(box!.width / 2), y: 2 } });

  await expectEmptyComposerCaret(textarea);
});

test("selecting a channel on mobile leaves the composer unfocused", async ({ page }) => {
  const textarea = await openTwoChannelWorkspace(page);

  await page.getByRole("button", { name: "Back to channels" }).click();
  await page.getByRole("button", { name: /random/i }).first().click();

  await expect(textarea).not.toBeFocused();
  await expect(textarea).toHaveValue("");
});

test.describe("desktop channel selection", () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  });

  test("continues to focus the empty composer with a visible caret", async ({ page }) => {
    const textarea = await openTwoChannelWorkspace(page);

    await page.getByRole("button", { name: /random/i }).first().click();

    await expectEmptyComposerCaret(textarea);
  });

  test("keeps the caret in the composer after sending, by Enter or by the Send button", async ({ page }) => {
    const textarea = await openTwoChannelWorkspace(page);
    await fixtureJson(page, "send-message", new RegExp(`/api/xmatrix/channels/${E2E_CHANNEL.id}/messages$`, "u"),
      { message: { messageId: "m-1" } }, { method: "POST", delayMs: 400 });

    await textarea.focus();
    await textarea.pressSequentially("first");
    await page.keyboard.press("Enter");
    await expect(textarea).toHaveValue(/^\u200B?$/u);
    await expect(textarea).toBeFocused();

    await textarea.pressSequentially("second");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(textarea).toHaveValue(/^\u200B?$/u);
    await expect(textarea).toBeFocused();
    await page.keyboard.type("third");
    await expect(textarea).toHaveValue("third");
  });

  test("draws a soft caret on one middle line with the hint chip and the attach button", async ({ page }) => {
    const textarea = await openTwoChannelWorkspace(page);
    await textarea.focus();
    await expectEmptyComposerCaret(textarea);
    const caret = page.locator(".app-composer-caret").first();
    await expect(caret).toBeVisible();
    await expect.poll(() => textarea.evaluate((node) => getComputedStyle(node).caretColor)).toBe("rgba(0, 0, 0, 0)");

    const middles = await page.evaluate(() => {
      const middle = (element: Element | null) => {
        const box = element!.getBoundingClientRect();
        return { middle: (box.top + box.bottom) / 2, width: box.width };
      };
      return {
        row: middle(document.querySelector(".composer-input-row")),
        attach: middle(document.querySelector(".composer-attach .app-composer-inline-icon")),
        chip: middle(document.querySelector(".app-composer-hint-trigger")),
        caret: middle(document.querySelector(".app-composer-caret")),
      };
    });
    expect(middles.caret.width).toBe(2);
    for (const part of [middles.attach, middles.chip, middles.caret]) {
      expect(Math.abs(part.middle - middles.row.middle)).toBeLessThanOrEqual(0.75);
    }

    const before = await caret.boundingBox();
    await textarea.pressSequentially("hi");
    await expect.poll(async () => (await caret.boundingBox())!.x).toBeGreaterThan(before!.x + 5);
    // The caret jumps with the selection; no easing trails behind it.
    expect(await caret.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0s");
    const typed = (await caret.boundingBox())!.x;
    await textarea.press("ArrowLeft");
    const moved = await caret.evaluate((node) => new Promise<number>((resolve) =>
      requestAnimationFrame(() => resolve(node.getBoundingClientRect().x))));
    expect(moved).toBeLessThan(typed - 1);

    await textarea.evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionstart")));
    await expect(caret).toBeHidden();
    await expect.poll(() => textarea.evaluate((node) => getComputedStyle(node).caretColor)).not.toBe("rgba(0, 0, 0, 0)");
    await textarea.evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionend")));
    await expect(caret).toBeVisible();
  });
});
