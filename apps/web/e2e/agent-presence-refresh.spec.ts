import { expect, test } from "./fixtures";
import { refreshCatalogChannel } from "./channel-catalog-refresh";
import {
  E2E_CHANNEL, E2E_SPACE, E2E_NOW, E2E_DESKTOP_CONTEXT,
  E2E_MOBILE_CONTEXT, installWorkspaceStubs, fixtureRequests, fixtureJson,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

test("catalog refresh preserves live Agent tags and busy, then accepts idle", async ({ page }, testInfo) => {
  const initial = {
    id: "instance-codex", channelInstanceId: "1", label: "Codex:1",
    connectedAt: E2E_NOW, lastSeenAt: E2E_NOW, status: "idle",
  };
  const channel = (instance: Record<string, unknown>, name = "general") => ({
    ...E2E_CHANNEL, name,
    memberPresence: { "agent:codex": { kind: "agent", label: "Codex", instances: [instance] } },
  });
  const live = { ...initial, status: "busy", lastSeenAt: "2026-07-01T00:00:10.000Z",
    model: "gpt-live", effort: "high", gitBranch: "fix/presence-refresh",
    statusChips: [{ id: "sandbox", label: "Sandbox", value: "workspace-write" }],
  };
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel(live)] });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  const details = page.locator(".app-details");
  const chips = details.locator("[data-live-agent-header-chips]");
  const assertLive = async () => {
    await expect(details.getByText(/^busy$/i)).toBeVisible();
    await expect(chips.locator("[data-status-chip='model']")).toContainText("gpt-live");
    await expect(chips.locator("[data-status-chip='effort']")).toContainText("high");
    await expect(chips.locator("[data-status-chip='sandbox']")).toContainText("workspace-write");
  };
  await assertLive();
  for (const [index, update] of [initial, { ...initial, status: "busy",
    lastSeenAt: "2026-07-01T00:00:15.000Z" }].entries()) {
    const rule = `presence-refresh-${index}`;
    await refreshCatalogChannel(page, rule, channel(update, `refreshed-${index}`));
    await assertLive();
  }
  // DOM existence alone misses overflow clipping. Every tag must fit the rail.
  const geometry = await chips.evaluate(element => {
    const rail = element.closest(".app-details")!.getBoundingClientRect();
    return Array.from(element.querySelectorAll("[data-status-chip], [data-live-agent-branch]"))
      .map(chip => { const rect = chip.getBoundingClientRect();
        return rect.width > 0 && rect.left >= rail.left && rect.right <= rail.right; });
  });
  expect(geometry).toEqual([true, true, true, true]);
  await testInfo.attach("live-tags-after-catalog-refresh", {
    body: await details.screenshot(), contentType: "image/png",
  });
  await refreshCatalogChannel(page, "presence-idle", channel({ ...initial,
    lastSeenAt: "2026-07-01T00:00:20.000Z" }, "finished"));
  await expect(details.getByText(/^idle$/i)).toBeVisible();
  await expect(chips.locator("[data-status-chip='model']")).toContainText("gpt-live");
});

for (const [device, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["mobile", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(`runtime symptoms on ${device}`, () => {
    test.use(context);
    test("shows issues beside each Instance, keeps the task, and clears on recovery", async ({ page }, testInfo) => {
      const sinceMillis = Date.now() - 120_000;
      const base = { connectedAt:E2E_NOW, lastSeenAt:E2E_NOW, status:"busy", intent:"Verify current task" };
      const instances = [
        {...base,id:"i-retry",channelInstanceId:"1",label:"Codex:1",runtimeState:{status:"running",issue:{kind:"retrying",sinceMillis}}},
        {...base,id:"i-stall",channelInstanceId:"2",label:"Codex:2",runtimeState:{status:"running",issue:{kind:"stalled",sinceMillis}}},
        {...base,id:"i-notice",channelInstanceId:"3",label:"Codex:3",runtimeState:{status:"running",notice:{severity:"error",sinceMillis}}},
      ];
      const channel = (items: unknown[], name = "general") => ({...E2E_CHANNEL,name,memberPresence:{"agent:codex":{kind:"agent",label:"Codex",instances:items}}});
      await installWorkspaceStubs(page,{spaces:[E2E_SPACE],channels:[channel(instances)]});
      await page.goto("/app/personal-sspaceperso/channels/channel-general");
      const dock = page.locator(".app-agent-work-dock");
      const retry = dock.locator("[data-runtime-issue='retrying']");
      await expect(retry).toContainText("Connection retrying");
      await expect(retry).toBeVisible();
      await expect(retry.locator("..").locator(".app-agent-work-intent")).toContainText("Verify current task");
      const stalled = dock.locator("[data-runtime-issue='stalled']");
      await expect(stalled).toContainText("No runtime progress");
      const advisory = dock.locator("[data-runtime-notice='error']");
      await advisory.scrollIntoViewIfNeeded();
      await expect(advisory).toContainText("Agent error notice");
      await expect(advisory.locator("..").locator("[data-runtime-issue='failed']")).toHaveCount(0);
      await advisory.getByRole("button",{name:"Dismiss Agent notice"}).click();
      await expect(advisory).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await retry.scrollIntoViewIfNeeded();
      const geometry = await retry.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {width:rect.width,left:rect.left,right:rect.right,viewport:window.innerWidth};
      });
      expect(geometry.width).toBeGreaterThan(0);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      const screenshot = testInfo.outputPath(`runtime-issues-${device}.png`);
      await dock.screenshot({path:screenshot});
      await testInfo.attach(`runtime-issues-${device}`,{path:screenshot,contentType:"image/png"});
      // Public symptoms and dismissal must never open or fetch private Trace.
      const traceReads = /\/trace\/instances\/[^/]+\/events|trace.*history|trace-history/;
      expect((await fixtureRequests(page,"api-catch-all")).filter(url => traceReads.test(url))).toHaveLength(0);
      const traceRule = `runtime-trace-${device}`;
      await fixtureJson(page, traceRule, /\/api\/xmatrix\/trace\/instances\/i-retry\/events(?:[?]|$)/,
        {availability:"available",complete:true,events:[],cursor:null,nextCursor:null});
      await retry.getByRole("button", {name:/Connection retrying/}).click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect.poll(async () => (await fixtureRequests(page,traceRule)).length).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const recovered = instances.map(instance => ({...instance,lastSeenAt:"2026-07-01T00:00:20.000Z",runtimeState:{status:"running"}}));
      await refreshCatalogChannel(page,`runtime-recovered-${device}`,channel(recovered,"recovered"));
      await expect(dock.locator("[data-runtime-issue]")).toHaveCount(0);
      await expect(dock.locator(".app-agent-work-intent").first()).toContainText("Verify current task");
    });
  });
}
