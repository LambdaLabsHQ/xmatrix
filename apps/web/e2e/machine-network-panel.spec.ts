import { expect, test } from "./fixtures";
import { E2E_NOW, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

// The panel must distinguish failed HTTPS from healthy ICMP and missing data
// from zero, while keeping diagnostics behind the info control.
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
    const row = (label: string) => panel.getByRole("group", { name: label, exact: true });
    const details = panel.getByRole("button", { name: "Network details", exact: true });
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByLabel("Network measurement details")).toHaveCount(0);
    if (state === "expired") {
      await expect(panel.getByRole("img", { name: "Not measured", exact: true })).toBeVisible();
      for (const label of ["Latency", "Packet loss", "Download", "Upload"]) await expect(row(label)).toHaveText("—");
    } else {
      await expect(panel.getByRole("img", { name: state === "failed" ? "HTTPS probe failed" :
        state === "partial" ? "Some HTTPS requests failed" : "HTTPS reachable", exact: true })).toBeVisible();
      await expect(row("Packet loss")).toContainText(state === "partial" ? "1.0%" : "0.0%");
      if (state === "failed") {
        for (const label of ["Latency", "Download", "Upload"]) await expect(row(label)).toHaveText("—");
      } else {
        await expect(row("Latency")).toContainText("50 ms");
        await expect(row("Download")).toContainText("≈80.0 Mbps");
        await expect(row("Download")).toHaveAttribute("title", /short sample/u);
        await expect(row("Upload")).toContainText("8.0 Mbps");
        await expect(row("Upload")).not.toContainText("≈");
      }
    }
    await details.click();
    await expect(details).toHaveAttribute("aria-expanded", "true");
    const evidence = panel.getByLabel("Network measurement details");
    await expect(evidence).toBeVisible();
    if (state === "expired") await expect(evidence).toContainText("No recent network measurement");
    else {
      await expect(evidence).toContainText("HTTPS to Cloudflare Speed");
      await expect(evidence).toContainText("ICMP directly to 1.1.1.1");
      await expect(evidence).toContainText(state === "failed" ? "0/10 requests succeeded" : state === "partial" ? "8/10 requests succeeded" : "10/10 requests succeeded");
      if (state !== "failed") {
        await expect(evidence).toContainText("Latency p95: 100 ms · Jitter: 12 ms");
        await expect(evidence).toContainText("Loaded latency 200 ms");
        await expect(evidence).toContainText("≈ Short sample");
      }
      await expect(evidence.locator("time")).toHaveAttribute("title", /UTC|GMT/u);
    }
    await details.click();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "network stays within the page").toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`network-${state}.png`), fullPage: true });
  });
}
