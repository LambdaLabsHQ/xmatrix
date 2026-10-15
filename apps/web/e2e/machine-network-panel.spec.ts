import { expect, test } from "./fixtures";
import { E2E_NOW, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

// The panel must distinguish failed HTTPS from healthy ICMP and missing data
// from zero. The text formatter's test cannot cover these rows or their bars.
const network = { observedAt: E2E_NOW, target: "cloudflare-speed", protocol: "https", attempts: 10, failures: 0,
  latencyMedianMs: 50, latencyP95Ms: 100, jitterMs: 12,
  packetLoss: { protocol: "icmp", target: "1.1.1.1", sent: 100, received: 100 },
  download: { observedAt: E2E_NOW, bytes: 1_000_000, durationMs: 100, mbps: 80, shortSample: true, loadedLatencyMs: 150 },
  upload: { observedAt: E2E_NOW, bytes: 1_000_000, durationMs: 1000, mbps: 8, shortSample: false, loadedLatencyMs: 200 } };
const states = ["measured", "partial", "failed", "expired"] as const;

for (const mobile of [false, true]) for (const state of states) {
  test(`network ${state} stays clear on ${mobile ? "mobile" : "desktop"}`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 393, height: 852 } : { width: 1400, height: 1000 });
    await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 120_000) });
    const sample = { ...network, ...(state === "failed" ? { failures: 10, download: undefined, upload: undefined } : {}),
      ...(state === "partial" ? { failures: 2, packetLoss: { ...network.packetLoss, received: 99 } } : {}),
      ...(state === "expired" ? { observedAt: new Date(Date.parse(E2E_NOW) - 16 * 60_000).toISOString() } : {}) };
    await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [{
      id: "network-daemon", userId: "e2e-user", email: "e2e@xmatrix.test", name: "network-daemon", status: "online",
      machineId: "machine:network", machineName: "Laptop", hostId: "network-host", hostName: "network-host",
      connectedAt: E2E_NOW, lastSeenAt: E2E_NOW,
      metadata: { platform: "macos", machineResources: { observedAt: E2E_NOW, cpuUsagePercent: 30, network: sample } },
    }] });
    await page.goto("/app/personal-sspaceperso/machines");
    await page.getByTestId("machine-row").filter({ hasText: "Laptop" }).click();
    const panel = page.getByRole("region", { name: "Machine network quality" });
    await expect(panel.getByRole("heading", { name: "Network", exact: true })).toBeVisible();
    const row = (label: string) => panel.getByText(label, { exact: true }).locator("..");
    if (state === "expired") {
      await expect(panel).toContainText("Not measured");
      await expect(panel).toContainText("No recent network measurement");
      await expect(panel.getByRole("meter")).toHaveCount(0);
      await expect(panel).not.toContainText("0%");
    } else {
      await expect(panel).toContainText(state === "failed" ? "HTTPS probe failed" :
        state === "partial" ? "Some HTTPS requests failed" : "HTTPS reachable");
      const success = state === "failed" ? "0" : state === "partial" ? "80" : "100";
      await expect(panel.getByRole("meter", { name: "HTTPS success", exact: true })).toHaveAttribute("aria-valuenow", success);
      await expect(row("HTTPS success")).toContainText(`${success}%`);
      await expect(row("Packet loss (ICMP)")).toContainText(state === "partial" ? "1.0%" : "0.0%");
      // Latency and speed have no known capacity denominator and get no bar.
      await expect(panel.getByRole("meter")).toHaveCount(2);
      if (state === "failed") {
        for (const label of ["Latency (p50)", "Jitter", "Download", "Upload"]) await expect(row(label)).toContainText("Unknown");
      } else {
        await expect(row("Latency (p50)")).toContainText("50 ms");
        await expect(row("Latency (p50)")).toContainText("p95 100 ms");
        await expect(row("Download")).toContainText("80.0 Mbps");
        await expect(row("Download")).toContainText("Short sample");
        await expect(row("Upload")).toContainText("8.0 Mbps");
        await expect(row("Upload")).not.toContainText("Short sample");
        await panel.getByText("Measurement details", { exact: true }).click();
        await expect(panel).toContainText("Latency during upload: 200 ms");
        await expect(panel.locator(`time[datetime="${E2E_NOW}"]`).first()).toHaveAttribute("title", /UTC|GMT/u);
      }
    }
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "network stays within the page").toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`network-${state}.png`), fullPage: true });
  });
}
