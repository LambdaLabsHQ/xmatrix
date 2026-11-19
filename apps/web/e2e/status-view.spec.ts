import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

/* Agents is one destination: its list is every machine with the agents on it,
   and the paper beside it is what is chosen there. Nothing chosen, it is the
   overview: how many agents are working, where each one works, what each
   runtime does, and every machine with who works on it. */

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
let nextChannelSlot = 0;
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
        channelId: E2E_CHANNEL.id, channelInstanceId: String(++nextChannelSlot), since: recent() })) },
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
  memberPresence: Object.fromEntries(registrations.map((item, index) => [`agent:${index}`, { registration: { ownerUserId: item.key.ownerUserId, machineId: item.key.machineId, harness: item.key.harness },
    kind: "agent", status: "online", label: `${item.key.harness}-${index}`,
    instances: item.live.running.map((instance, slot) => ({ id: instance.instanceId,
      channelInstanceId: instance.channelInstanceId, label: `${item.key.harness}-${index}:${slot + 1}`,
      channelId: E2E_CHANNEL.id, connectedAt: E2E_NOW, lastSeenAt: E2E_NOW,
      status: item.idle > slot ? "idle" : "busy" })) }])),
};
async function openStatus(page: import("@playwright/test").Page) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [channel], machineDaemons: daemons });
  await fixtureJson(page, "status-catalog", /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?.*)?$/u, {
    registrations,
    capabilities: [...new Set(registrations.map((item) => item.key.harness))].sort().map((harness) => ({
      harness, models: [], locations: registrations.filter((item) => item.key.harness === harness) })),
  });
  await page.goto("/app/personal-sspaceperso/status");
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Agents is a dock tab that counts the Space at work and opens a machine", async ({ page }) => {
    await openStatus(page);
    const dock = page.getByRole("navigation", { name: "Primary" });
    await expect(dock.getByRole("button", { name: "Agents" })).toBeVisible();
    await expect(page.getByTestId("status-working").filter({ visible: true })).toHaveText("11");
    await expect(page.getByTestId("status-summary").filter({ visible: true })).toHaveText("2/3 machines busy");

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

    await rows.nth(0).tap();
    await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/machines\?machine=/u);
    await expect(page.locator(".app-tool-detail:visible").getByRole("heading", { level: 2, name: "busy-box" })).toBeVisible();
    // A machine is an address of the same tab: the dock still says Agents, and Back returns to its list.
    await expect(dock.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-current", "page");
    await page.locator(".app-tool-detail:visible").getByRole("button", { name: "Agents" }).tap();
    await expect(page.getByTestId("machine-row").filter({ visible: true })).toHaveCount(machines.length);
  });
});

test("the desktop rail has one Agents entry, whose overview opens a runtime and a working agent's conversation", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStatus(page);
  const rail = page.locator(".app-rail");
  await expect(rail.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Status", exact: true })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "Machines", exact: true })).toHaveCount(0);
  const busy = page.getByTestId("status-machine-row").filter({ visible: true, hasText: "busy-box" });
  await expect(busy.getByTestId("machine-load-glance")).toBeVisible();
  // Every agent with work in hand is named with its conversation.
  await expect(page.getByTestId("status-working-now").filter({ visible: true })).toHaveCount(6);
  // A runtime opens what is set on that agent, whichever machine it runs on.
  await page.getByTestId("status-runtime").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/agents\?agent=agent(%3A|:)codex$/u);
  await expect(page.locator(".app-tool-detail").getByRole("heading", { level: 2, name: "codex" })).toBeVisible();
});

test("on a desktop one list holds every machine with its agents, and stays beside whatever it opens", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStatus(page);
  // Its own list takes the conversation list's place.
  await expect(page.locator(".app-sidebar")).toBeHidden();
  const list = page.getByRole("navigation", { name: "Agents list" });
  await expect(list.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();

  // Every machine is listed, each with the agents on it under it.
  await expect(list.getByTestId("machine-row")).toHaveCount(machines.length);
  await expect(list.getByTestId("agent-row")).toHaveCount(registrations.length);
  const busy = list.getByRole("region", { name: "busy-box" });
  await expect(busy.getByTestId("agent-row")).toHaveCount(2);
  const codex = busy.getByTestId("agent-row").filter({ hasText: "codex" });
  await expect(codex).toContainText("5 running in #");
  // An agent starts where its machine's name does, so it reads as on that machine.
  const [name, face] = await Promise.all([busy.getByTestId("machine-row").locator(".app-list-row-title").boundingBox(),
    codex.locator(".app-tool-state-icon").boundingBox()]);
  expect(Math.abs(face!.x - name!.x)).toBeLessThanOrEqual(1);

  // Nothing chosen here: the overview is the list's first row and the paper beside it.
  const overview = list.getByTestId("fleet-overview-row");
  await expect(overview).toHaveAttribute("aria-current", "true");
  await expect(overview).toContainText("11 working · 3/4 machines online");
  await expect(page.getByTestId("status-working").filter({ visible: true })).toHaveText("11");
  await expect(page.getByTestId("status-machine-row").filter({ visible: true })).toHaveCount(machines.length);

  // An agent and a machine open beside the same list, each at its own address.
  await codex.click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/agents\?agent=/u);
  await expect(codex).toHaveAttribute("aria-current", "true");
  await expect(overview).not.toHaveAttribute("aria-current", "true");
  await expect(list.getByTestId("machine-row")).toHaveCount(machines.length);
  // The agent's page names its machine, which opens that machine.
  await page.getByTestId("agent-open-machine").click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/machines\?machine=/u);
  await expect(busy.getByTestId("machine-row")).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".app-tool-detail").getByRole("heading", { level: 2, name: "busy-box" })).toBeVisible();
  await overview.click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/status$/u);
});
