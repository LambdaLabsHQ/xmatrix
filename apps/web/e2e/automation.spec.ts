import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { E2E_CHANNEL, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";
import { fixtureJson } from "./in-page-api-fixtures";

test.use({ viewport: { width: 1280, height: 900 } });

const E2E_AUTOMATION = {
  id: "task-local",
  version: 1,
  ownerUserId: "e2e-user",
  authorityRootUserId: "e2e-user",
  name: "Existing schedule",
  channelId: E2E_CHANNEL.id,
  canManage: true,
  capabilities: {
    update: true,
    pause: true,
    requestPause: false,
    resume: false,
    delete: true,
    reasonRequired: false,
  },
  message: { body: "@codex:once:/tmp/xmatrix-e2e Run the existing schedule." },
  expression: {
    kind: "text" as const,
    ref: "scheduled-task:task-local",
    language: "natural-language" as const,
    text: "@codex:once:/tmp/xmatrix-e2e Run the existing schedule.",
  },
  input: {
    datum: {
      kind: "text" as const,
      ref: "scheduled-task:task-local",
      language: "natural-language" as const,
      text: "@codex:once:/tmp/xmatrix-e2e Run the existing schedule.",
    },
    envRef: {
      root: { kind: "channel" as const, id: E2E_CHANNEL.id },
      actor: { kind: "user" as const, id: "e2e-user" },
      authorityRootUserId: "e2e-user",
    },
    resume: { kind: "interval" as const, intervalMinutes: 60 },
    lineage: { rootMessageId: "scheduled-task:task-local", depth: 0, budget: 128 },
  },
  intervalMinutes: 60,
  enabled: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  nextRunAt: "2026-07-01T01:00:00.000Z",
  runCount: 0,
  deliveryCount: 0,
};

const E2E_AUTOMATION_READY_FIXTURES = {
  spaces: [E2E_SPACE],
  channels: [E2E_CHANNEL],
};

const E2E_PAUSED_AUTOMATION = {
  ...E2E_AUTOMATION,
  enabled: false,
  capabilities: {
    ...E2E_AUTOMATION.capabilities,
    pause: false,
    resume: true,
  },
};

/** The page an Automation is on, and its sections. */
async function stubAutomationPages(page: Page, spaceId = E2E_SPACE.id) {
  const goals = { pageId: `goals-${spaceId}`, parentPageId: null, title: `Goals of ${spaceId}`, position: "V",
    accessMode: "open", headRevision: 1, agentSuggestOnly: false, canEdit: true, updatedAt: "2026-07-01T00:00:00.000Z" };
  await fixtureJson(page, `automation-pages-${spaceId}`, new RegExp(`/api/xmatrix/spaces/${spaceId}/pages(?:\\?.*)?$`, "u"),
    { pages: [goals] });
  await fixtureJson(page, `automation-page-${spaceId}`, new RegExp(`/api/xmatrix/spaces/${spaceId}/pages/${goals.pageId}$`, "u"),
    { page: { ...goals, body: "# Goals\n\n## Architecture\n\nNo bloat.\n", revisionInfo: { revision: 1, kind: "edit",
      authors: [], conversationIds: [], basedOnRevision: null, createdAt: "2026-07-01T00:00:00.000Z" } } });
  return goals;
}

const scheduleRow = (page: Page, name: string) =>
  page.locator('[data-testid="schedule-row"]').filter({ hasText: name });

async function openSchedule(page: Page, name: string) {
  await page.getByRole("button", { name: "Schedules" }).click();
  await scheduleRow(page, name).click();
  await expect(page.locator(".app-tool-detail").getByRole("heading", { level: 2, name })).toBeVisible();
}

async function openAutomationEditor(page: Page, automation: typeof E2E_AUTOMATION) {
  await openWorkspaceWithStubs(page, {
    ...E2E_AUTOMATION_READY_FIXTURES,
    automations: [automation],
  });
  await openSchedule(page, automation.name);
  await page.getByRole("button", { name: "Edit" }).click();
}

test("Automation distinguishes failed catalogs from empty catalogs", async ({ page }) => {
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [E2E_CHANNEL],
    automationsError: "Automation catalog is unavailable.",
  });

  await page.getByRole("button", { name: "Schedules" }).click();

  await expect(page.getByText("Couldn't load Automations. xMatrix is still unavailable after several tries.", { exact: false })).toBeVisible();
  await expect(page.getByText("No schedules yet.")).toHaveCount(0);
});

test("Automation renders genuine empty catalogs only after loading succeeds", async ({ page }) => {
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [E2E_CHANNEL],
    automations: [],
  });

  await page.getByRole("button", { name: "Schedules" }).click();

  await expect(page.getByText("No schedules yet.")).toBeVisible();
  await expect(page.getByText("Loading schedules…")).toHaveCount(0);
});

test("channel readers see Automation expectations without management controls", async ({ page }) => {
  const readOnlyTask = {
    ...E2E_AUTOMATION,
    canManage: false,
    capabilities: {
      update: false,
      pause: false,
      requestPause: false,
      resume: false,
      delete: false,
      reasonRequired: false,
    },
  };
  await openWorkspaceWithStubs(page, {
    ...E2E_AUTOMATION_READY_FIXTURES,
    automations: [readOnlyTask],
  });

  const details = page.locator(".app-details");
  await expect(details.getByText("Existing schedule", { exact: true })).toBeVisible();
  await expect(details.getByText(readOnlyTask.expression.text, { exact: true })).toBeVisible();
  await expect(details.getByText("Root evaluation · actor user:e2e-user", { exact: true })).toBeVisible();
  await expect(details.getByText("read only", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Pause" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Delete lineage" })).toHaveCount(0);
});

test("Automation exits edit mode when the edited task is deleted", async ({ page }) => {
  await openAutomationEditor(page, E2E_AUTOMATION);
  await expect(page.getByLabel("Name")).toHaveValue("Existing schedule");
  await expect(page.getByLabel("What it does each time")).toHaveValue(E2E_AUTOMATION.expression.text);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete" }).click();

  await expect(scheduleRow(page, "Existing schedule")).toHaveCount(0);
  await expect(page.getByLabel("Name")).toHaveCount(0);
  await expect(page.getByText("Nothing in this Space runs on a schedule")).toBeVisible();
});

test("Schedules lists Automations by page and makes none; an empty Space is sent to Pages", async ({ page }) => {
  await openWorkspaceWithStubs(page, {
    ...E2E_AUTOMATION_READY_FIXTURES,
    automations: [],
  });
  await page.getByRole("button", { name: "Schedules" }).click();
  await expect(page.getByText("Nothing in this Space runs on a schedule")).toBeVisible();
  await expect(page.getByRole("button", { name: "Schedule", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Expression data")).toHaveCount(0);
  await page.getByRole("button", { name: "Open Pages" }).click();
  await expect(page).toHaveURL(/\/pages/);
});

test("a page's Automation is listed by what it is doing, names its page, and its address names it", async ({ page }) => {
  await openWorkspaceWithStubs(page, {
    ...E2E_AUTOMATION_READY_FIXTURES,
    automations: [{ ...E2E_AUTOMATION, pageId: `goals-${E2E_SPACE.id}`, spaceId: E2E_SPACE.id, blockId: "architecture" }],
  });
  const goals = await stubAutomationPages(page);
  await page.getByRole("button", { name: "Schedules" }).click();
  const group = page.locator('[data-testid="schedule-row"]').locator("xpath=ancestor::section[1]");
  await expect(group.getByText("Running", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(scheduleRow(page, "Existing schedule")).toContainText(goals.title);
  await expect(page.getByText("Up next")).toBeVisible();

  await scheduleRow(page, "Existing schedule").click();
  await expect(page).toHaveURL(/[?&]item=task-local/);
  await expect(page.locator(".app-tool-detail").getByText(`${goals.title} › Architecture`)).toBeVisible();
  await page.goBack();
  await expect(page.getByText("Up next")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("schedules-overview.png") });

  await scheduleRow(page, "Existing schedule").click();
  await page.locator(".app-tool-detail").getByRole("button", { name: `${goals.title} › Architecture` }).click();
  await expect(page).toHaveURL(new RegExp(`/pages\\?page=goals-${E2E_SPACE.id}`));
});

test("a conversation's details open its Automation in Schedules instead of offering to add one", async ({ page }) => {
  await openWorkspaceWithStubs(page, {
    ...E2E_AUTOMATION_READY_FIXTURES,
    automations: [E2E_AUTOMATION],
  });
  const details = page.locator(".app-details");
  await expect(details.getByText("Existing schedule", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Add schedule" })).toHaveCount(0);
  await details.getByRole("button", { name: "Edit Existing schedule" }).click();
  await details.getByRole("button", { name: "Open in Schedules" }).click();
  await expect(page.getByLabel("Name")).toHaveValue("Existing schedule");
  await expect(page).toHaveURL(/[?&]item=task-local/);
});

test("Automation refreshes task state while the page remains open", async ({ page }) => {
  await page.clock.install();
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [E2E_CHANNEL],
    automationResponses: [
      [E2E_AUTOMATION],
      [{
        ...E2E_PAUSED_AUTOMATION,
        name: "Refreshed schedule",
        lastDeliveryAt: "2026-07-01T00:30:00.000Z",
        lastMessageId: "scheduled-message:one",
        deliveryCount: 1,
        lastError: "Channel is archived",
      }],
    ],
  });
  await openSchedule(page, "Existing schedule");

  await page.clock.runFor(15_000);

  const detail = page.locator(".app-tool-detail");
  await expect(detail.getByRole("heading", { level: 2, name: "Refreshed schedule" })).toBeVisible();
  await expect(detail.getByText("Paused", { exact: true })).toBeVisible();
  await expect(detail.getByText("Last delivered", { exact: true })).toBeVisible();
  await expect(detail.getByText("Its last run failed: Channel is archived", { exact: true })).toBeVisible();
});

test("Automation keeps stale tasks visible but fails closed when refresh loses capability", async ({ page }) => {
  await page.clock.install();
  await openWorkspaceWithStubs(page, {
    ...E2E_AUTOMATION_READY_FIXTURES,
    automationResponses: [[E2E_PAUSED_AUTOMATION]],
    automationResponseErrors: [null, "Automation refresh is unavailable."],
  });
  await openSchedule(page, "Existing schedule");
  await expect(page.getByRole("button", { name: "Resume" })).toBeEnabled();

  await page.clock.runFor(15_000);

  await expect(page.getByText("Couldn't load Automations. xMatrix is still unavailable after several tries.", { exact: false })).toBeVisible();
  await expect(scheduleRow(page, "Existing schedule")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume" })).toBeDisabled();
});

test("Automation fails closed when scheduled execution is unavailable", async ({ page }) => {
  await openWorkspaceWithStubs(page, {
    ...E2E_AUTOMATION_READY_FIXTURES,
    automations: [E2E_PAUSED_AUTOMATION],
    automationExecutionEnabled: false,
  });
  await openSchedule(page, "Existing schedule");

  await expect(page.getByText("Scheduled runs are unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume" })).toBeDisabled();
});

test("an Automation stored without a name is listed by what it does instead of breaking Schedules", async ({ page }) => {
  const { name: _unnamed, ...withoutName } = E2E_PAUSED_AUTOMATION;
  await openWorkspaceWithStubs(page, {
    ...E2E_AUTOMATION_READY_FIXTURES,
    automations: [withoutName, { ...E2E_PAUSED_AUTOMATION, id: "task-second", name: "Second" }],
  });
  await page.getByRole("button", { name: "Schedules" }).click();
  await expect(scheduleRow(page, "@codex:once:/tmp/xmatrix-e2e Run the existing schedule.")).toBeVisible();
  await expect(scheduleRow(page, "Second")).toBeVisible();
});
