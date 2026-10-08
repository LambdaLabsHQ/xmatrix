import { expect, test } from './fixtures';
import { E2E_CHANNEL, E2E_SPACE, openGeneralChannelWithHistory, openWorkspaceWithStubs } from './workspace-fixtures';

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} chrome and detail cards share Summary wood`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, summary: 'Shared original wood material.' }, []);
    if (mobile) await page.getByRole('button', { name: 'More', exact: true }).tap();
    const summary = page.locator('.app-detail-plank').filter({ has: page.getByRole('heading', { name: 'Summary', exact: true }) });
    await expect(summary).toBeVisible();
    const paint = await summary.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.backgroundImage, style.backgroundSize, style.backgroundPosition, style.backgroundBlendMode];
    });
    expect(paint[1]).toContain('/textures/wood.webp');
    const selectors = mobile ? ['.app-topbar .app-mobile-back-sign', '.app-detail-plank'] : ['.app-rail', '.app-detail-plank'];
    for (const selector of selectors) {
      for (const element of await page.locator(selector).all()) {
        expect(await element.evaluate((node) => {
          const style = getComputedStyle(node);
          return [style.backgroundColor, style.backgroundImage, style.backgroundSize, style.backgroundPosition, style.backgroundBlendMode];
        })).toEqual(paint);
      }
    }
    if (!mobile) {
      expect(await page.locator('.app-rail').evaluate((node) => ['::before', '::after'].map((pseudo) => getComputedStyle(node, pseudo).display))).toEqual(['none', 'none']);
    }
    await page.screenshot({ path: testInfo.outputPath('wood-material.png') });
  });
}

// Wood carries only liquid glass, and Profile, Activity and More are paper:
// Settings' paper under the wood bar, with no board, plaque or glass card.
for (const view of ['profile', 'activity', 'more']) {
  test(`mobile ${view} is paper under the wood bar`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
    await page.goto(`/app/${E2E_SPACE.id}/${view}`);
    const paper = page.locator('.app-mobile-dock-page:not([inert]) .app-tool-paper');
    await expect(paper).toBeVisible();
    const surfaces = await paper.evaluate((root) => [root, ...Array.from(root.querySelectorAll('*'))]
      .filter((element) => !element.closest('button, a, input, textarea, [data-slot="button"]'))
      .flatMap((element) => {
        const style = getComputedStyle(element);
        return style.backgroundImage.includes('wood.webp') || style.backdropFilter !== 'none'
          ? [element.className.toString()] : [];
      }));
    expect(surfaces).toEqual([]);
    // The bar is paper; its wood is the sign: the Space's on a dock root, the chevron and title's on a pushed screen.
    const wood = page.locator('.app-topbar.app-mobile-tab-root-bar :is(.app-mobile-space-trigger, .app-mobile-title), .app-topbar .app-mobile-back-sign');
    expect(await wood.first().evaluate((node) => getComputedStyle(node).backgroundImage)).toContain('wood.webp');
  });
}

test('mobile channel details puts its navigation and content planks on paper', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, summary: 'Planks on paper.' }, []);
  await page.getByRole('button', { name: 'More', exact: true }).tap();
  const sheet = page.locator('.app-mobile-channel-details-surface');
  await expect(sheet.locator('.app-detail-plank').first()).toBeVisible();
  const woodBehind = await sheet.evaluate((node) => [node, ...Array.from(node.querySelectorAll('.app-material-scroll-content'))]
    .flatMap((element) => [null, '::before', '::after'].map((pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return style.content === 'none' && pseudo ? 'none' : style.backgroundImage;
    }))
    .filter((image) => image.includes('wood.webp')));
  expect(woodBehind).toEqual([]);
  expect(await sheet.locator('.app-mobile-channel-details-header').evaluate((node) => getComputedStyle(node).backgroundImage)).toContain('wood.webp');
});
