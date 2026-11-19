import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

/* Agents is one destination. On a desktop it is a matrix, a machine to a row
   and an agent to a column, and whatever is opened from it takes its place
   with a way back; on a phone, too narrow for it, the same machines are a
   list with their agents under them. One count says who works, everywhere:
   an Instance with work in hand. A live process waiting for its next message
   is ready. */

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
async function openStatus(page: import("@playwright/test").Page, listed: Array<(typeof registrations)[number]> = registrations) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [channel], machineDaemons: daemons });
  await fixtureJson(page, "status-catalog", /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?.*)?$/u, {
    registrations: listed,
    capabilities: [...new Set(listed.map((item) => item.key.harness))].sort().map((harness) => ({
      harness, models: [], locations: listed.filter((item) => item.key.harness === harness) })),
  });
  await page.goto("/app/personal-sspaceperso/status");
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Agents is a dock tab: the Space at work, then every machine with its agents, each opening in place", async ({ page }) => {
    await openStatus(page);
    const dock = page.getByRole("navigation", { name: "Primary" });
    await expect(dock.getByRole("button", { name: "Agents" })).toBeVisible();
    // On a phone the avatar matrix leads directly without a giant count hero; active work shows quietly.
    const matrix = page.getByTestId("fleet-matrix");
    await expect(matrix).toContainText("Working");
    await expect(page.getByTestId("status-machine-row")).toHaveCount(0);

    const machine = (name: string) => matrix.getByRole("region", { name });
    await expect(page.getByTestId("machine-row").filter({ visible: true })).toHaveCount(machines.length);
    await expect(machine("busy-box").getByTestId("machine-load-glance")).toHaveText("CPU 95%");
    // Healthy idle machines stay quiet (no "Idle" or "Ready" prose), while each avatar carries its full accessible state.
    await expect(machine("idle-box").getByTestId("machine-row")).not.toContainText("Idle");
    await expect(machine("idle-box").getByTestId("agent-row")).toHaveAttribute("aria-label", /Ready/u);
    // Offline machines note their offline state once on the machine row.
    await expect(machine("gone-box").getByTestId("machine-row")).toContainText("Offline");
    await expect(machine("gone-box").getByTestId("agent-row")).toHaveAttribute("data-state", "offline");

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

test("on a desktop Agents is a matrix of machines and agents, which says each of them once", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStatus(page);
  const rail = page.locator(".app-rail");
  await expect(rail.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Status", exact: true })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "Machines", exact: true })).toHaveCount(0);
  // The matrix is the list: no column of machines stands beside it, and the conversation list gives way to it.
  await expect(page.locator(".app-sidebar")).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Agents list" })).toHaveCount(0);
  await expect(page.locator(".app-main").getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await expect(page.getByTestId("status-working")).toHaveText("11");
  await expect(page.getByTestId("status-summary")).toHaveText("on 2 machines");

  const matrix = page.getByTestId("fleet-matrix");
  // A machine to a row, an agent to a column: each is named once.
  await expect(matrix.getByTestId("machine-row")).toHaveCount(machines.length);
  await expect(matrix.getByTestId("fleet-agent-column")).toHaveText(["claude", "codex", "cursor", "gemini"]);
  await expect(matrix.getByTestId("agent-row")).toHaveCount(registrations.length);
  const row = (name: string) => matrix.getByRole("row", { name });
  await expect(row("busy-box").getByTestId("machine-row")).toContainText("7 working");
  await expect(row("busy-box").getByRole("button", { name: /^codex on busy-box/u })).toContainText("5 working");
  // Three live processes wait for a message on idle-box: none of them works, so it is idle and its agent ready.
  await expect(row("idle-box").getByTestId("machine-row")).toContainText("Idle");
  await expect(row("idle-box").getByRole("button", { name: /^codex on idle-box/u })).toHaveText("Ready");
  // A machine says it is offline once, on its row; the agent on it says only that it is on.
  await expect(row("gone-box").getByTestId("machine-row")).toContainText("Offline");
  await expect(row("gone-box").getByTestId("agent-row")).toHaveText("On");
  // A row is quiet until a reading is under strain, and then draws only that reading.
  await expect(row("busy-box").getByTestId("machine-load-glance")).toHaveAccessibleName("CPU 95%");
  await expect(row("wide-box").getByTestId("machine-load-glance")).toHaveCount(0);
  // Nothing waits on a person here; when something does, it is its own cell, not a second list.
  await expect(page.getByTestId("fleet-attention-count")).toHaveCount(0);
  await expect(page.getByTestId("status-attention")).toHaveCount(0);
  // A machine that has not reported what it holds offers nothing to turn on or install: an empty cell, not a guess.
  await expect(matrix.getByTestId("fleet-cell")).toHaveCount(0);
});

test("what waits on a person is counted once, as its own cell", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  // The weekly window of claude on wide-box is used up; its access on busy-box was never confirmed, which stops no work.
  const spent = { remainingPercent: 0, observedAt: recent(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    windows: [{ label: "1w", usedPercent: 100, resetAt: new Date(Date.now() + 86_400_000).toISOString() }] };
  await openStatus(page, registrations.map((item) => item.key.harness !== "claude" ? item
    : item.key.machineId === "machine:wide" ? { ...item, live: { ...item.live, quota: spent } }
      : item.key.machineId === "machine:busy" ? { ...item, canManageOwnerGrant: true,
        access: { mode: "full", confirmed: false, args: [], env: {}, session: {}, approvesRequests: false } } : item));
  const matrix = page.getByTestId("fleet-matrix");
  const spentCell = matrix.getByRole("button", { name: /^claude on wide-box/u });
  await expect(spentCell).toHaveAttribute("data-state", "attention");
  await expect(spentCell).toContainText("1w limit");
  // The count beside the total is exactly the cells in that ink: nothing is listed a second time, and an
  // agent that can still take work is not among them.
  await expect(page.getByTestId("fleet-attention-count")).toHaveText(" · 1 needs attention");
  await expect(matrix.locator('[data-testid="agent-row"][data-state="attention"]')).toHaveCount(1);
  await expect(page.getByTestId("status-attention")).toHaveCount(0);
  await expect(matrix.getByRole("button", { name: /^claude on busy-box/u })).toHaveAttribute("data-state", "running");
});

test("a heading or a cell of the matrix opens in its place, with a way back", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStatus(page);
  const matrix = page.getByTestId("fleet-matrix");
  const paper = page.locator(".app-tool-detail");
  const back = paper.getByRole("button", { name: "Agents", exact: true });

  // A column's heading: the agent across its machines, counted as the matrix counts it.
  await matrix.getByTestId("fleet-agent-column").filter({ hasText: "codex" }).click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/agents\?agent=agent(%3A|:)codex$/u);
  await expect(paper.getByRole("heading", { level: 2, name: "codex" })).toBeVisible();
  await expect(paper).toContainText("On 3 machines · 6 working");
  await expect(matrix).toHaveCount(0);
  await back.click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/status$/u);

  // A cell is edited in place: its editor opens under it, and what is set on the agent is one step further.
  await matrix.getByRole("button", { name: /^codex on busy-box/u }).click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/status$/u);
  await expect(page.getByTestId("fleet-cell-editor").filter({ visible: true })).toContainText("Codex on busy-box");
  await page.getByTestId("fleet-cell-open-agent").click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/agents\?agent=/u);
  await expect(paper.getByTestId("agent-instance")).toHaveCount(5);
  await expect(paper.getByTestId("agent-instance").first()).toContainText("Working");
  await expect(paper.getByText("Where it runs")).toHaveCount(0);
  // Its header names its machine, which opens that machine: its agents first.
  await page.getByTestId("agent-open-machine").click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/machines\?machine=/u);
  await expect(paper.getByRole("heading", { level: 2, name: "busy-box" })).toBeVisible();
  await expect(paper.getByRole("heading", { level: 3 }).first()).toHaveText("Agents on this machine");
  await back.click();
  await expect(matrix).toBeVisible();

  // An Instance waiting for its next message is listed as waiting, and counted nowhere as work.
  await matrix.getByRole("button", { name: /^codex on idle-box/u }).click();
  await expect(page.getByTestId("fleet-cell-editor").filter({ visible: true })).toContainText("Waiting");
  await page.getByTestId("fleet-cell-open-agent").click();
  await expect(paper.getByTestId("agent-instance")).toHaveCount(3);
  await expect(paper.getByTestId("agent-instance").first()).toContainText("Waiting for a message");
  await back.click();

  // A row's heading: the machine. Its bare address is the matrix too, with no list to pick from.
  await matrix.getByRole("row", { name: "wide-box" }).getByTestId("machine-row").click();
  await expect(paper.getByRole("heading", { level: 2, name: "wide-box" })).toBeVisible();
  await page.goto("/app/personal-sspaceperso/machines");
  await expect(page.getByTestId("fleet-matrix")).toBeVisible();
});
