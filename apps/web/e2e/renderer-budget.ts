import type { Page } from "@playwright/test";

/**
 * The renderer main thread's share of time over a run and over each window of
 * it, as the browser itself accounts for it: every task, the product's script,
 * style, layout and native work alike. Nothing is subtracted for an idle page.
 */
export async function rendererBudget(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const read = async () => Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]),
  ) as Record<string, number>;
  const share = (from: Record<string, number>, to: Record<string, number>) =>
    (to.TaskDuration! - from.TaskDuration!) / (to.Timestamp! - from.Timestamp!);
  const start = await read();
  let windowStart = start;
  const windows: number[] = [];
  return {
    /** Ends the window that began with the run or with the window before it. */
    async closeWindow() {
      const now = await read();
      windows.push(share(windowStart, now));
      windowStart = now;
    },
    /** The whole run so far. Reads once: nothing is drained first. */
    async total() {
      const now = await read();
      const spent = (name: string) => Number((now[name]! - start[name]!).toFixed(2));
      return {
        busy: share(start, now),
        elapsed: now.Timestamp! - start.Timestamp!,
        windows,
        script: spent("ScriptDuration"),
        style: spent("RecalcStyleDuration"),
        layout: spent("LayoutDuration"),
        styleUpdates: now.RecalcStyleCount! - start.RecalcStyleCount!,
      };
    },
  };
}
