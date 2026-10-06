import { expect, test, type Page } from "./fixtures";
import {
  E2E_DESKTOP_CONTEXT,
  E2E_MOBILE_CONTEXT,
  E2E_SPACE,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";
import { fixtureJson } from "./in-page-api-fixtures";

/* Desktop SegmentedTabs is one concentric control: every tab — chosen, idle,
   hovered — shares one corner radius, and the track's radius is that radius
   plus the track's padding and border. A phone tray is the other shape: the
   track and every tab are the same capsule, because 10px beside 7px read as
   two corners. A June-era structural rule
   (`.border:has(> button.bg-primary) > button`) once outranked the theme and
   made the idle tabs 9999px pills beside a smaller chosen tab; Team's
   Current/All showed it first. A computed-style read is the only thing that
   catches that kind of cascade fight. */

async function segmentedGeometry(page: Page) {
  return page.locator(".app-segmented-track").evaluateAll((tracks) => tracks.map((track) => {
    const style = getComputedStyle(track);
    const tabs = [...track.querySelectorAll<HTMLElement>(":scope > .app-segmented-tab")];
    return {
      label: track.getAttribute("aria-label"),
      track: parseFloat(style.borderTopLeftRadius),
      inset: parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth),
      tabs: tabs.map((tab) => parseFloat(getComputedStyle(tab).borderTopLeftRadius)),
    };
  }));
}

async function expectConcentric(page: Page, context: string) {
  const tracks = await segmentedGeometry(page);
  expect(tracks.length, `${context}: segmented controls`).toBeGreaterThan(0);
  for (const { label, track, inset, tabs } of tracks) {
    expect(new Set(tabs).size, `${context} ${label}: one tab radius, got ${tabs}`).toBe(1);
    expect(track, `${context} ${label}: track radius concentric with tabs`).toBeCloseTo(tabs[0] + inset, 0);
  }
}

async function expectCapsule(page: Page, context: string) {
  const tracks = await segmentedGeometry(page);
  expect(tracks.length, `${context}: segmented controls`).toBeGreaterThan(0);
  for (const { label, track, tabs } of tracks) {
    expect(new Set(tabs).size, `${context} ${label}: one tab radius, got ${tabs}`).toBe(1);
    expect(track, `${context} ${label}: track is a capsule`).toBeGreaterThanOrEqual(999);
    expect(tabs[0], `${context} ${label}: tabs are capsules`).toBeGreaterThanOrEqual(999);
  }
}

async function expectEveryTabAndHover(page: Page, context: string) {
  await page.mouse.move(0, 0);
  await expectConcentric(page, context);
  const idle = page.locator(".app-segmented-tab[aria-selected='false']").first();
  await idle.hover();
  await expectConcentric(page, `${context} (hover)`);
}

/* The app's segmented control is Billing's interval: Monthly or Yearly, on a
   Free Space whose owner can upgrade it. */
const BILLING = {
  plan: "free", canManage: true, seats: { used: 1, limit: 3 },
  freeUsage: { acceptedMessages: 12, limit: 500, remaining: 488 }, subscription: null,
};

async function openBilling(page: Page) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  await fixtureJson(page, "geometry-billing", /\/api\/xmatrix\/spaces\/[^/]+\/billing$/u, { billing: BILLING });
  await page.goto("/app/personal-sspaceperso/settings?item=billing");
  await expect(page.getByRole("tab", { name: "Monthly" })).toBeVisible();
}

test.describe("segmented tabs on desktop (wood)", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("the Billing interval keeps one concentric radius", async ({ page }) => {
    await openBilling(page);
    await page.evaluate(() => document.documentElement.setAttribute("data-app-theme", "wood"));
    await expectEveryTabAndHover(page, "Billing");
    await page.getByRole("tab", { name: /^Yearly/ }).click();
    await expectEveryTabAndHover(page, "Billing → Yearly");
  });
});


test.describe("segmented tabs on a phone", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("the tray is one capsule on Billing", async ({ page }) => {
    await openBilling(page);
    await expectCapsule(page, "Billing (phone)");
  });
});
