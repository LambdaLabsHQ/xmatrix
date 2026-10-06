import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  E2E_MOBILE_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  fixtureJson,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

test.use(E2E_MOBILE_CONTEXT);

/* The tool surface clips horizontally on phones (overflow-x: hidden), so any
   content that lands past its right edge is unreachable rather than scrollable.
   Machines is the worst case: a nowrap machine ID used to set the automatic
   minimum size of the shared detail grid track, pushing every row's value out
   of the card. */
const MACHINE_ID = "Machine:c50a4b0b-6de5-485a-b89e-8968c6eef6a1";
const HOST_NAME = "DanieldeMacBook-Air.local";
const LIVE_HEARTBEAT_AT = new Date().toISOString();

const WORKSPACE = {
  machineId: MACHINE_ID,
  canonicalCwd: "/Users/e2e/dev/xmatrix",
  ownerUserId: "e2e-user",
  hostId: "host-overflow",
  hostName: HOST_NAME,
  displayName: "xmatrix",
  runtimesSeen: ["claude"],
  boundChannelIds: [],
  visibility: "space",
  createdAt: E2E_NOW,
  updatedAt: E2E_NOW,
  lastSeenAt: E2E_NOW,
  metadata: {},
};

const DAEMON = {
  id: "daemon-overflow",
  userId: "e2e-user",
  email: "e2e@xmatrix.test",
  name: "xmatrix-daemon-overflow",
  status: "online",
  machineId: MACHINE_ID,
  machineName: HOST_NAME,
  hostId: "host-overflow",
  hostName: HOST_NAME,
  daemonVersion: "0.0.1",
  cliVersion: "0.0.1",
  connectedAt: E2E_NOW,
  lastSeenAt: LIVE_HEARTBEAT_AT,
  metadata: {},
};

/** Every element inside the active tool surface that renders past its clipped right edge. */
async function contentPastRightEdge(page: Page) {
  // The dock keeps a pane per tab, so offscreen tabs can hold a tool surface
  // too; only the visible pane is the one under test.
  // Settings reads as a list beside a section; the section open on the phone is the surface.
  return page.locator(".app-mobile-dock-page:not([inert]) :is(.app-tool-surface, .app-tool-detail)").evaluate((surface) => {
    const limit = Math.min(
      surface.getBoundingClientRect().right,
      document.documentElement.clientWidth
    );
    const escaped: Array<{ selector: string; text: string; overshoot: number }> = [];
    for (const element of surface.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const overshoot = Math.round(rect.right - limit);
      // Sub-pixel rounding on fractional layout widths is not a defect.
      if (overshoot <= 1) continue;
      const className = typeof element.className === "string" ? element.className : "";
      escaped.push({
        selector: `${element.tagName.toLowerCase()}.${className.split(/\s+/).filter(Boolean).join(".")}`,
        text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
        overshoot,
      });
    }
    return escaped;
  });
}

test("machine cards keep every detail value inside the mobile tool surface", async ({ page }) => {
  await page.clock.setFixedTime(new Date(E2E_NOW));
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    workspaces: [WORKSPACE],
    machineDaemons: [DAEMON],
  });
  await page.goto("/app/personal-sspaceperso/machines");
  // The row's machine mark carries its presence; no separate word or dot says it.
  const machineRow = page.locator('[data-testid="machine-row"]').filter({ hasText: HOST_NAME });
  await expect(machineRow.locator('.app-tool-state-icon[data-state="running"]')).toHaveCount(1);
  await expect(machineRow).not.toContainText("online");
  // On a phone the list comes first; a machine's page is pushed over it.
  await machineRow.tap();

  await expect(page.getByRole("heading", { name: HOST_NAME })).toBeVisible();
  expect(await contentPastRightEdge(page)).toEqual([]);

  // The values that used to be pushed out of the card stay readable.
  // "online" in the DOM; the detail row only capitalises it in CSS.
  await expect(page.locator(".app-tool-detail").getByText("online", { exact: true }).first()).toBeVisible();
  // A Machine is shown by its name; its id is never part of the card.
  await expect(page.getByText(/c50a4b0b-6de5-485a-b89e-8968c6eef6a1/i)).toHaveCount(0);
});

/* pages/profile, like machines/automation, has a route segment; without one a
   deep link or a reload fell through to the legacy [channelId] redirect and
   dropped the user on the channel list. */
test("More and dock views survive a deep link instead of falling back to channels", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });

  for (const view of ["machines", "automation", "pages", "profile"]) {
    await page.goto(`/app/personal-sspaceperso/${view}`);
    await expect(page).toHaveURL(new RegExp(`/app/personal-sspaceperso/${view}$`));
  }
});

test("a long secret alias does not push the settings column off the surface", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  // Registered after the bootstrap stubs so this handler wins the catch-all.
  await fixtureJson(page, "secrets", "**/api/xmatrix/spaces/*/secrets**", {
    canManage: true,
    secrets: [{
      secretRef: "OPENROUTER_API_KEY_PRODUCTION_FLEET_ROTATION_2026",
      envName: "OPENROUTER_API_KEY",
      access: "auto",
      description: "Router key",
      createdByUserId: "e2e-user",
      createdAt: E2E_NOW,
      updatedAt: E2E_NOW,
    }],
  });
  await page.goto("/app/personal-sspaceperso/settings?item=secrets");

  await expect(page.getByText("OPENROUTER_API_KEY_PRODUCTION_FLEET_ROTATION_2026")).toBeVisible();
  expect(await contentPastRightEdge(page)).toEqual([]);
});

test("activity rows keep the event label whole when the agent name is long", async ({ page }) => {
  const agentName = "claude-alex-alexs-macbook-pro";
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  // Registered after the bootstrap stubs so this handler wins the catch-all.
  await fixtureJson(page, "observable-events", "**/api/xmatrix/observable/events**", {
    events: [{
      id: "event-overflow",
      type: "agent_connected",
      workspaceUserId: "e2e-user",
      agentId: "agent-overflow",
      agentName,
      timestamp: E2E_NOW,
      metadata: {},
    }],
  });
  await page.goto("/app/personal-sspaceperso/activity");

  const label = page.getByText("agent connected", { exact: true });
  await expect(label).toBeVisible();
  expect(await label.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(await contentPastRightEdge(page)).toEqual([]);
});
