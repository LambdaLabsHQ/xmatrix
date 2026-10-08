import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

/* Status is the Space at work: how many agents are working, what each runtime
   does, every machine with who works on it, and what runs next. Rows only grow
   downward, so the page holds any number of machines and runtimes. */

const recent = () => new Date().toISOString();
const machines = [
  { machineId: "machine:busy", name: "busy-box", platform: "linux", online: true },
  { machineId: "machine:wide", name: "wide-box", platform: "linux", online: true },
  { machineId: "machine:idle", name: "idle-box", platform: "macos", online: true },
  { machineId: "machine:gone", name: "gone-box", platform: "linux", online: false },
];
const daemons = machines.map((machine, index) => ({
  id: `daemon-${index}`, userId: "e2e-user", email: "e2e@xmatrix.test", name: `daemon-${index}`,
  status: machine.online ? "online" : "offline", machineId: machine.machineId, machineName: machine.name,
  hostId: machine.name, hostName: machine.name, daemonVersion: "0.16.600", cliVersion: "0.16.600",
  connectedAt: E2E_NOW, lastSeenAt: recent(),
  metadata: { platform: machine.platform, ...(machine.online ? { machineResources: { observedAt: recent(),
    cpuUsagePercent: 40, cpuLogicalCount: 8, memoryTotalBytes: 100, memoryAvailableBytes: 50,
    diskTotalBytes: 100, diskAvailableBytes: 80 } } : {}) },
}));
const registration = (machineId: string, harness: string, working: number, idle = 0) => {
  // The first `idle` Instances wait for a message; the rest are in a turn.
  const machine = machines.find((candidate) => candidate.machineId === machineId)!;
  return {
    key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId, harness },
    displayName: harness, ownerName: "E2E Tester", machineName: machine.name, version: 1, state: "enabled",
    models: [], routingReady: true, canManageOwnerGrant: false, canConfigureSpace: false, canRemoveFromSpace: false,
    idle,
    live: { machine: { online: machine.online, lastSeenAt: recent(), platform: machine.platform },
      running: Array.from({ length: working + idle }, (_, index) => ({ instanceId: `${machineId}-${harness}-${index}`,
        channelId: E2E_CHANNEL.id, channelInstanceId: String(index + 1), since: recent() })) },
  };
};
const registrations = [
  registration("machine:busy", "codex", 5), registration("machine:busy", "claude", 2),
  registration("machine:wide", "claude", 1), registration("machine:wide", "codex", 1),
  registration("machine:wide", "cursor", 1), registration("machine:wide", "gemini", 1),
  // Live processes waiting for their next message run but do not work.
  registration("machine:idle", "codex", 0, 3), registration("machine:gone", "claude", 0),
];
// Who works is what the conversation shows: its busy Instances, as on the conversation list.
const channel = {
  ...E2E_CHANNEL,
  memberPresence: Object.fromEntries(registrations.map((item, index) => [`agent:${index}`, {
    kind: "agent", status: "online", label: `${item.key.harness}-${index}`,
    instances: item.live.running.map((instance, slot) => ({ id: instance.instanceId,
      channelInstanceId: instance.channelInstanceId, label: `${item.key.harness}-${index}:${slot + 1}`,
      channelId: E2E_CHANNEL.id, connectedAt: E2E_NOW, lastSeenAt: E2E_NOW,
      status: item.idle > slot ? "idle" : "busy" })) }])),
};
const automation = (id: string, name: string, minutes: number) => ({
  id, version: 1, ownerUserId: "e2e-user", authorityRootUserId: "e2e-user", name, channelId: E2E_CHANNEL.id,
  canManage: true, capabilities: { update: true, pause: true, requestPause: false, resume: false, delete: true,
    reasonRequired: false },
  message: { body: "Check" }, expression: { kind: "text", ref: `task:${id}`, language: "natural-language", text: "Check" },
  intervalMinutes: 60, enabled: true, createdAt: E2E_NOW, updatedAt: E2E_NOW,
  nextRunAt: new Date(Date.now() + minutes * 60_000).toISOString(), runCount: 0, deliveryCount: 0,
});

async function openStatus(page: import("@playwright/test").Page) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [channel], machineDaemons: daemons,
    automations: [automation("later", "Weekly digest", 120), automation("soon", "Nightly sync", 4)] });
  await fixtureJson(page, "status-catalog", /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?.*)?$/u, {
    registrations,
    capabilities: [...new Set(registrations.map((item) => item.key.harness))].sort().map((harness) => ({
      harness, models: [], locations: registrations.filter((item) => item.key.harness === harness) })),
  });
  await page.goto("/app/personal-sspaceperso/status");
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Status is a dock tab that counts the Space at work and opens a machine", async ({ page }) => {
    await openStatus(page);
    const dock = page.getByRole("navigation", { name: "Primary" });
    await expect(dock.getByRole("button", { name: "Status" })).toBeVisible();
    await expect(page.getByTestId("status-working").filter({ visible: true })).toHaveText("11");
    await expect(page.getByTestId("status-summary").filter({ visible: true })).toHaveText("2/3 machines busy · 2 schedules");

    // Each runtime once, busiest first; one with nobody working is faint, not hidden.
    const runtimes = page.getByTestId("status-runtime").filter({ visible: true });
    await expect(runtimes).toHaveCount(4);
    await expect(runtimes.first()).toHaveAccessibleName(/^codex: 6 working/u);

    // Machines: busiest first, offline last; a row names at most three runtimes and counts the rest.
    const rows = page.getByTestId("status-machine-row").filter({ visible: true });
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("busy-box");
    await expect(rows.nth(0)).toContainText("7 working");
    await expect(rows.nth(1)).toContainText("+1");
    await expect(rows.nth(2)).toContainText("Idle");
    await expect(rows.nth(3)).toContainText("Offline");

    // What runs next, soonest first.
    await expect(page.getByTestId("status-schedule-row").filter({ visible: true }).first()).toContainText("Nightly sync");

    await rows.nth(0).tap();
    await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/machines\?item=/u);
    await expect(page.locator(".app-tool-detail:visible").getByRole("heading", { level: 2, name: "busy-box" })).toBeVisible();
  });
});

test("the desktop rail opens Status, where each machine row shows its load", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStatus(page);
  await expect(page.locator(".app-rail").getByRole("button", { name: "Status", exact: true })).toBeVisible();
  const busy = page.getByTestId("status-machine-row").filter({ hasText: "busy-box" });
  await expect(busy.getByTestId("machine-load-glance")).toBeVisible();
  await page.getByRole("button", { name: "All agents" }).click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/agents$/u);
});

test("on a desktop Status lists the work in its own column, with the overview beside it", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStatus(page);
  // Its own list takes the conversation list's place.
  await expect(page.locator(".app-sidebar")).toBeHidden();
  const list = page.getByRole("navigation", { name: "Status list" });
  await expect(list.getByRole("heading", { name: "Status", level: 1 })).toBeVisible();
  const work = list.getByTestId("status-work-row");
  await expect(work).toHaveCount(11);
  await expect(list.getByRole("region", { name: "Working" })).toContainText("11");
  await expect(list.getByTestId("status-next-row").first()).toContainText("Nightly sync");

  // Nothing chosen: the overview at a glance.
  await expect(page.getByTestId("status-working").filter({ visible: true })).toHaveText("11");

  // A working Instance opens beside the list, with its trace and its conversation one step away.
  await work.first().click();
  await expect(page).toHaveURL(/\/status\?item=work%3A/u);
  const detail = page.locator(".app-tool-detail:visible");
  await expect(detail.getByRole("button", { name: "Trace" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Conversation" })).toBeVisible();
  await expect(page.getByTestId("status-working").filter({ visible: true })).toHaveCount(0);

  await list.getByTestId("status-next-row").first().click();
  await expect(detail.getByRole("heading", { level: 2, name: "Nightly sync" })).toBeVisible();
});
