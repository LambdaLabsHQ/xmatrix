import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

/* Status is the Space at work: how many agents are working and what each
   runtime does, then the Agents, Machines and Schedules lists one after
   another, a line per row, each row opening in its own destination. */

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

    // Machines as the Machines list orders them, each saying what it does.
    const rows = page.getByTestId("machine-row").filter({ visible: true });
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("busy-box");
    await expect(rows.nth(3)).toContainText("Offline");

    await rows.nth(0).tap();
    await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/machines\?item=/u);
    await expect(page.locator(".app-tool-detail:visible").getByRole("heading", { level: 2, name: "busy-box" })).toBeVisible();
  });
});

test("the desktop rail opens Status, where each machine row shows its load", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStatus(page);
  await expect(page.locator(".app-rail").getByRole("button", { name: "Status", exact: true })).toBeVisible();
  const busy = page.getByTestId("machine-row").filter({ visible: true, hasText: "busy-box" });
  await expect(busy.getByTestId("machine-load-glance")).toBeVisible();
  await page.getByRole("button", { name: "All agents" }).click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/agents$/u);
});

test("on a desktop Status lists agents, machines and schedules a line each, opening each in its destination", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStatus(page);
  // Its own list takes the conversation list's place.
  await expect(page.locator(".app-sidebar")).toBeHidden();
  const list = page.getByRole("navigation", { name: "Status list" });
  await expect(list.getByRole("heading", { name: "Status", level: 1 })).toBeVisible();
  const agents = list.getByTestId("agent-row");
  await expect(agents).toHaveCount(registrations.length);
  await expect(list.getByTestId("machine-row")).toHaveCount(machines.length);
  const schedules = list.getByTestId("schedule-row");
  await expect(schedules.first()).toContainText("Nightly sync");

  // A line per row, so the whole Space fits on one screen.
  for (const row of [agents.first(), list.getByTestId("machine-row").first(), schedules.first()]) {
    expect((await row.boundingBox())!.height).toBeLessThan(40);
  }
  const lastRow = (await schedules.last().boundingBox())!;
  expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(900);

  // Nothing is chosen here: the overview stays beside the list.
  await expect(page.getByTestId("status-working").filter({ visible: true })).toHaveText("11");

  await schedules.first().click();
  await expect(page).toHaveURL(/\?item=soon$/u);
  await expect(page.locator(".app-tool-detail:visible").getByRole("heading", { level: 2, name: "Nightly sync" })).toBeVisible();

  await page.goBack();
  await list.getByTestId("agent-row").first().click();
  await expect(page).toHaveURL(/\/agents\?item=/u);
});
