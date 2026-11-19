import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

/* Agents is one destination: its list is every machine with the agents on it,
   and the paper beside it is what is chosen there. Nothing chosen, it is the
   overview: how many agents are working, what waits on a person, and each
   agent across its machines. One count says who works, everywhere: an Instance
   with work in hand. A live process waiting for its next message is ready. */

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
  // Only busy-box is under strain: its processor is the one reading a list row draws.
  metadata: { platform: machine.platform, ...(machine.online ? { machineResources: { observedAt: recent(),
    cpuUsagePercent: machine.name === "busy-box" ? 95 : 40, cpuLogicalCount: 8, memoryTotalBytes: 100, memoryAvailableBytes: 50,
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

  test("Agents is a dock tab: the Space at work, then every machine with its agents, each opening in place", async ({ page }) => {
    await openStatus(page);
    const dock = page.getByRole("navigation", { name: "Primary" });
    await expect(dock.getByRole("button", { name: "Agents" })).toBeVisible();
    await expect(page.getByTestId("status-working").filter({ visible: true })).toHaveText("11");
    await expect(page.getByTestId("status-summary").filter({ visible: true })).toHaveText("on 2 machines");

    // Each agent once across its machines, busiest first.
    const runtimes = page.getByTestId("status-runtime").filter({ visible: true });
    await expect(runtimes).toHaveCount(4);
    await expect(runtimes.first()).toHaveAccessibleName(/^codex: 6 working, on 2 machines · 1 ready/u);

    // The machines are the list's to say, once: the overview does not repeat them.
    await expect(page.getByTestId("status-machine-row")).toHaveCount(0);
    await expect(page.getByText("Machines · 3/4 online").filter({ visible: true })).toBeVisible();
    const machine = (name: string) => page.getByRole("region", { name });
    await expect(page.getByTestId("machine-row").filter({ visible: true })).toHaveCount(machines.length);
    await expect(machine("busy-box").getByTestId("machine-row")).toContainText("7 working");
    await expect(machine("wide-box").getByTestId("machine-row")).toContainText("4 working");
    // Three live processes wait for a message on idle-box: none of them works, so it is idle and its agent ready.
    await expect(machine("idle-box").getByTestId("machine-row")).toContainText("Idle");
    await expect(machine("idle-box").getByTestId("agent-row")).toContainText("Ready");
    await expect(machine("idle-box").getByTestId("agent-row")).not.toContainText("running");
    // A machine says it is offline; the agent under it does not say it again.
    await expect(machine("gone-box").getByTestId("machine-row")).toContainText("Offline");
    await expect(machine("gone-box").getByTestId("agent-row")).not.toContainText("Offline");

    await machine("busy-box").getByTestId("machine-row").tap();
    await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/machines\?machine=/u);
    const paper = page.locator(".app-tool-detail:visible");
    await expect(paper.getByRole("heading", { level: 2, name: "busy-box" })).toBeVisible();
    // A machine is an address of the same tab: the dock still says Agents, the bar is still the Space's,
    // and its own way back returns to the list.
    await expect(dock.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".app-topbar")).toContainText(E2E_SPACE.name);
    await expect(page.locator(".app-topbar")).not.toContainText("Machines");
    await paper.getByRole("button", { name: "Agents" }).tap();
    await expect(page.getByTestId("machine-row").filter({ visible: true })).toHaveCount(machines.length);
  });
});

test("the desktop rail has one Agents entry, and its overview says only what the list beside it cannot", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStatus(page);
  const rail = page.locator(".app-rail");
  await expect(rail.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Status", exact: true })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "Machines", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("status-working").filter({ visible: true })).toHaveText("11");
  // Nothing waits on a person here, and the machines are read in the list, not a second time on the paper.
  await expect(page.getByTestId("status-attention")).toHaveCount(0);
  await expect(page.getByTestId("status-machine-row")).toHaveCount(0);
  // A machine's row is quiet until a reading is under strain, and then draws only that reading.
  const list = page.getByRole("navigation", { name: "Agents list" });
  await expect(list.getByRole("region", { name: "busy-box" }).getByTestId("machine-load-glance")).toHaveAccessibleName("CPU 95%");
  await expect(list.getByRole("region", { name: "wide-box" }).getByTestId("machine-load-glance")).toHaveCount(0);
  // An agent opens what is set on it, whichever machine it runs on, counted as the list counts it.
  await page.getByTestId("status-runtime").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/agents\?agent=agent(%3A|:)codex$/u);
  const paper = page.locator(".app-tool-detail");
  await expect(paper.getByRole("heading", { level: 2, name: "codex" })).toBeVisible();
  await expect(paper).toContainText("On 3 machines · 6 working");
});

test("on a desktop one list holds every machine with its agents, and stays beside whatever it opens", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStatus(page);
  // Its own list takes the conversation list's place.
  await expect(page.locator(".app-sidebar")).toBeHidden();
  const list = page.getByRole("navigation", { name: "Agents list" });
  await expect(list.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await expect(list.getByRole("heading", { name: "Machines · 3/4 online", level: 2 })).toBeVisible();

  // Every machine is listed, each with the agents on it under it.
  await expect(list.getByTestId("machine-row")).toHaveCount(machines.length);
  await expect(list.getByTestId("agent-row")).toHaveCount(registrations.length);
  const busy = list.getByRole("region", { name: "busy-box" });
  await expect(busy.getByTestId("agent-row")).toHaveCount(2);
  const codex = busy.getByTestId("agent-row").filter({ hasText: "codex" });
  await expect(codex).toContainText("5 working in #");
  // An agent starts where its machine's name does, so it reads as on that machine.
  const [name, face] = await Promise.all([busy.getByTestId("machine-row").locator(".app-list-row-title").boundingBox(),
    codex.locator(".app-tool-state-icon").boundingBox()]);
  expect(Math.abs(face!.x - name!.x)).toBeLessThanOrEqual(1);

  // Nothing chosen here: the overview is the list's first row and the paper beside it.
  const overview = list.getByTestId("fleet-overview-row");
  await expect(overview).toHaveAttribute("aria-current", "true");
  await expect(overview).toContainText("11 working");
  await expect(page.getByTestId("status-working").filter({ visible: true })).toHaveText("11");

  // An agent and a machine open beside the same list, each at its own address.
  await codex.click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/agents\?agent=/u);
  await expect(codex).toHaveAttribute("aria-current", "true");
  await expect(overview).not.toHaveAttribute("aria-current", "true");
  await expect(list.getByTestId("machine-row")).toHaveCount(machines.length);
  // Its page reads each of its Instances: where it is and whether it works; nothing its header already said.
  const paper = page.locator(".app-tool-detail");
  await expect(paper.getByTestId("agent-instance")).toHaveCount(5);
  await expect(paper.getByTestId("agent-instance").first()).toContainText("Working");
  await expect(paper.getByText("Where it runs")).toHaveCount(0);
  await list.getByRole("region", { name: "idle-box" }).getByTestId("agent-row").click();
  await expect(paper.getByTestId("agent-instance")).toHaveCount(3);
  await expect(paper.getByTestId("agent-instance").first()).toContainText("Waiting for a message");
  await codex.click();
  // The agent's page names its machine, which opens that machine: its agents first.
  await page.getByTestId("agent-open-machine").click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/machines\?machine=/u);
  await expect(busy.getByTestId("machine-row")).toHaveAttribute("aria-current", "true");
  await expect(paper.getByRole("heading", { level: 2, name: "busy-box" })).toBeVisible();
  await expect(paper.getByRole("heading", { level: 3 }).first()).toHaveText("Agents on this machine");
  await overview.click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/status$/u);
});
