import { expect, test } from "@playwright/test";

const cases = [
  { name: "Windows", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", href: "/api/desktop/releases/stable/latest-x64.exe" },
  { name: "macOS", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", href: "/api/desktop/releases/stable/latest-arm64.dmg" },
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
    const page = await context.newPage();
    await page.goto("/download");
    const recommendation = page.getByTestId("download-recommendation");
    await expect(recommendation.getByRole("link").first()).toHaveAttribute("href", scenario.href);
    if (scenario.name === "macOS") await expect(recommendation).toContainText("Apple Silicon");
    await recommendation.getByRole("link", { name: "All platforms and preview builds" }).click();
    await expect(page).toHaveURL(/#all-downloads$/);
    await expect(page.getByRole("link", { name: "Stable EXE", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download APK", exact: true })).toBeVisible();
    await context.close();
  });
}
