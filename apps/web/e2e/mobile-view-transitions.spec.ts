import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });

for (const scenario of ["superseded", "update failure", "invalid animation"] as const) {
  test(`mobile navigation preserves the update and observes ${scenario}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((scenario) => {
      const start = document.startViewTransition.bind(document);
      const state = { updates: 0, finished: false };
      Object.assign(window, { mobileTransitionTest: state });
      document.startViewTransition = ((update: () => void) => {
        // Exercise real browser promises: replace the app transition before
        // its first frame, or fail its DOM update. No synthetic rejections.
        const transition = start(() => {
          state.updates++;
          update();
          if (scenario === "update failure") throw new DOMException("navigation update failed", "AbortError");
        });
        if (scenario === "superseded") {
          const replacement = start(() => {});
          void replacement.finished.then(() => { state.finished = true; });
        }
        return transition;
      }) as typeof document.startViewTransition;
    }, scenario);
    await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
    await page.goto("/app/personal-sspaceperso/channels");
    if (scenario === "invalid animation") {
      await page.evaluate(() => {
        for (let i = 0; i < 2; i++) {
          const element = document.createElement("div");
          element.textContent = "Duplicate transition name";
          element.style.viewTransitionName = "duplicate";
          document.body.append(element);
        }
      });
    }
    await page.locator('[data-mobile-channel-row-id="channel-general"]').tap();
    await expect(page.locator(".app-mobile-channel-detail-bar")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.xmatrixMobileNavigation))
      .toBeUndefined();
    const state = () => page.evaluate(() => (
      window as typeof window & { mobileTransitionTest: { updates: number; finished: boolean } }
    ).mobileTransitionTest);
    expect((await state()).updates).toBe(1);
    if (scenario === "superseded") {
      await expect.poll(async () => (await state()).finished).toBe(true);
      expect(errors).toEqual([]);
    } else if (scenario === "update failure") {
      // Callback defects must still reach error reporting, even AbortErrors
      // from a failed state update must not be mistaken for skipped animation.
      await expect.poll(() => errors.some((error) => error.includes("navigation update failed"))).toBe(true);
    } else {
      await expect.poll(() => errors.some((error) => /duplicate|Invalid state/iu.test(error))).toBe(true);
    }
  });
}
