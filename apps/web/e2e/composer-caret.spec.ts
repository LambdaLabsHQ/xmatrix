import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
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
});
