import { expect, test } from "@playwright/test";

const appStore = "https://apps.apple.com/app/id6766625147";
const googlePlay = "https://play.google.com/store/apps/details?id=sh.xmatrix.app";
const platformHref: Record<string, string> = { macOS: "/download", Windows: "/download", iPhone: appStore, Android: googlePlay };

const devices = [
  { name: "macOS", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", action: "/api/desktop/releases/stable/latest-arm64.dmg", others: ["Windows", "iPhone", "Android"] },
  { name: "Windows", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", action: "/api/desktop/releases/stable/latest-x64.exe", others: ["macOS", "iPhone", "Android"] },
  { name: "iPhone", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", action: appStore, others: ["macOS", "Windows", "Android"] },
  { name: "Android", ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8)", action: googlePlay, others: ["macOS", "Windows", "iPhone"] },
  // No native App: the action starts in the browser, and the sentence names every App.
  { name: "Linux", ua: "Mozilla/5.0 (X11; Linux x86_64)", action: "/login", others: ["macOS", "Windows", "iPhone", "Android"] },
];

for (const device of devices) {
  test(`the homepage's action is the App for ${device.name}, at the top and at the foot`, async ({ browser }) => {
    const context = await browser.newContext({ userAgent: device.ua });
    // The test browser's own client hints describe the CI host, not a Mac.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "userAgentData", { value: { getHighEntropyValues: async () => ({ architecture: "arm" }) } });
    });
    const page = await context.newPage();
    await page.goto("/");
    for (const place of ["hero-download", "closing-download"]) {
      const actions = page.getByTestId(place);
      await expect(actions.getByRole("link").first()).toHaveAttribute("href", device.action);
      // Every other platform is one link away, named in the sentence under the action.
      for (const other of device.others) {
        await expect(actions.getByRole("link", { name: other, exact: true })).toHaveAttribute("href", platformHref[other]!);
      }
      await expect(actions.getByRole("link", { name: device.name, exact: true })).toHaveCount(0);
      // The browser is the action itself where there is no App, and the sentence's last link otherwise.
      await expect(actions.getByRole("link", { name: "open in browser", exact: true }))
        .toHaveCount(device.name === "Linux" ? 0 : 1);
    }
    await context.close();
  });
}

for (const width of [393, 1440]) {
  test(`the homepage shows the product running at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("xMatrix");
    await expect(page.getByRole("heading", { level: 2, name: "Get all your agents on the same page.", exact: true })).toBeVisible();
    // The phone app's two stores, as their own badges.
    await expect(page.getByRole("link", { name: "Download on the App Store", exact: true })).toHaveAttribute("href", appStore);
    await expect(page.getByRole("link", { name: "Get it on Google Play", exact: true })).toHaveAttribute("href", googlePlay);

    // A stage screens away is not run with the page: the matrix mounts on the way to it, further down.
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#agents .site-matrix")).toHaveCount(0);

    // The live document is the app's own editor, written by its Agents.
    const document = page.locator("#live-page .site-live-page");
    await document.scrollIntoViewIfNeeded();
    await expect(document.getByRole("heading", { name: "Launch: live docs" })).toBeVisible();
    // A desktop has the iPhone beside the document, in the conversation about the same project.
    await expect(page.locator("#live-page .site-phone")).toHaveCount(width >= 1024 ? 1 : 0);
    if (width >= 1024) await expect(page.locator("#live-page .site-phone")).toContainText("cut the launch video");

    // The app itself: a Mac window on a desktop, an iPhone on a phone.
    const conversations = page.locator("#conversations");
    await conversations.scrollIntoViewIfNeeded();
    await expect(conversations.locator(width >= 768 ? ".site-app-window" : ".site-phone")).toContainText("Looks great. Ship it.");

    // The Agents matrix, and under it every agent the registry holds, each with its mark.
    const agents = page.locator("#agents");
    await agents.scrollIntoViewIfNeeded();
    await expect(agents.locator(".site-matrix")).toContainText("Mac Studio");
    const list = agents.getByRole("list", { name: "Any machine. Any agent. All managed in one place.", exact: true });
    const marks = list.getByRole("listitem");
    expect(await marks.count()).toBeGreaterThan(30);
    // The sentence over them counts the same registry.
    await expect(agents.getByText(`${await marks.count()} coding agents running on your own Mac, Linux, and Windows machines`)).toBeVisible();
    for (const mark of await marks.all()) {
      await expect.poll(() => mark.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    }

    // The page never scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("a comparison panel on a phone is as wide as its row, whatever its scene holds", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 900 });
  await page.goto("/");
  const panel = page.locator("#why .site-why-panel").first();
  // A scene's widest line changes as the scene plays; one far wider than the screen stands in for all of them.
  await panel.locator(".site-why-scene > *").first().evaluate((scene: HTMLElement) => { scene.style.minWidth = "1000px"; });
  const widths = await panel.evaluate((figure) => ({
    panel: figure.getBoundingClientRect().width, row: figure.parentElement!.getBoundingClientRect().width,
  }));
  expect(widths.panel).toBeCloseTo(widths.row, 0);
  expect(widths.row).toBeLessThan(393);
});
