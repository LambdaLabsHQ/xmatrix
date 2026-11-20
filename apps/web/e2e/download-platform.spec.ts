import { expect, test } from "@playwright/test";

const cases = [
  { name: "Windows", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", href: "/api/desktop/releases/stable/latest-x64.exe" },
  { name: "macOS", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", href: "/api/desktop/releases/stable/latest-arm64.dmg", architecture: "arm", other: "/api/desktop/releases/stable/latest-x64.dmg" },
  { name: "Intel macOS", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", href: "/api/desktop/releases/stable/latest-x64.dmg", architecture: "x86", other: "/api/desktop/releases/stable/latest-arm64.dmg" },
  { name: "macOS without client hints", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", href: "/api/desktop/releases/stable/latest-arm64.dmg", architecture: null, other: "/api/desktop/releases/stable/latest-x64.dmg" },
  { name: "Android", ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8)", href: "/api/android/releases/stable/latest.apk" },
  { name: "iOS", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", href: "/app" },
  { name: "iPadOS desktop mode", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", href: "/app", ipad: true },
  { name: "Linux", ua: "Mozilla/5.0 (X11; Linux x86_64)", href: "/app" },
  { name: "unknown", ua: "UnknownBrowser", href: "/app" },
];

for (const scenario of cases) {
  test(`download recommendation for ${scenario.name}`, async ({ browser }) => {
    const context = await browser.newContext({ userAgent: scenario.ua });
    if (scenario.ipad) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "platform", { value: "MacIntel" });
        Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
      });
    }
    if ("architecture" in scenario) {
      // The test browser's own client hints describe the CI host, not a Mac.
      await context.addInitScript((architecture) => {
        Object.defineProperty(navigator, "userAgentData", {
          value: architecture === null ? undefined : { getHighEntropyValues: async () => ({ architecture }) },
        });
      }, scenario.architecture);
    }
    const page = await context.newPage();
    await page.goto("/download");
    const recommendation = page.getByTestId("download-recommendation");
    await expect(recommendation.getByRole("link").first()).toHaveAttribute("href", scenario.href);
    if (scenario.other) {
      await expect(recommendation).toContainText(scenario.architecture === "x86" ? "Intel-based Macs" : "Apple Silicon");
      await expect(recommendation.getByRole("link", { name: scenario.architecture === "x86" ? "Apple Silicon Mac" : "Intel Mac" })).toHaveAttribute("href", scenario.other);
    }
    await recommendation.getByRole("link", { name: "All platforms and preview builds" }).click();
    await expect(page).toHaveURL(/#all-downloads$/);
    // The list under the recommendation carries every build, whatever the device.
    const builds = {
      "macOS Apple Silicon": "/api/desktop/releases/stable/latest-arm64.dmg",
      "macOS Intel": "/api/desktop/releases/stable/latest-x64.dmg",
      "Windows Installer": "/api/desktop/releases/stable/latest-x64.exe",
      "Android APK": "/api/android/releases/stable/latest.apk",
      "Preview builds: Windows": "/api/desktop/releases/dev/latest-x64.exe",
      "macOS as ZIP: Preview Intel": "/api/desktop/releases/dev/latest-x64.zip",
    };
    for (const [name, href] of Object.entries(builds)) {
      const link = page.getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", href);
    }
    // One primary action on the page, and no sideways scrolling on a phone.
    await expect(page.locator(".download-page [data-material='wood-panel']")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await context.close();
  });
}
