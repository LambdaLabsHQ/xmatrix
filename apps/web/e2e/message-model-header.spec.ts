import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import {
  E2E_CHANNEL,
  E2E_NOW,
  E2E_SPACE,
  fixtureJson,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

test.use({
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

function agentMessage(overrides: {
  messageId: string;
  sequence: number;
  body: string;
  instanceId: string;
  channelInstanceId: string;
  instanceLabel: string;
  from?: Record<string, unknown>;
}) {
  return {
    messageId: overrides.messageId,
    channelId: "channel-general",
    sequence: overrides.sequence,
    body: overrides.body,
    sentAt: E2E_NOW,
    from: {
      identityId: "agent:codex",
      kind: "agent",
      label: "Codex",
      userId: "agent-owner",
      email: "codex@xmatrix.test",
      agentName: "Codex",
      instanceId: overrides.instanceId,
      channelInstanceId: overrides.channelInstanceId,
      instanceLabel: overrides.instanceLabel,
      ...overrides.from,
    },
  };
}

async function fulfillChannelHistory(page: Page, messages: unknown[]) {
  await fixtureJson(
    page,
    "channel-general-history",
    "**/api/xmatrix/channels/channel-general/history**",
    { messages, hasMore: false }
  );
}

function messageChannel() {
  return {
    ...E2E_CHANNEL,
    messageCount: 1,
    lastMessageSequence: 1,
    updatedAt: E2E_NOW,
  };
}

async function openGeneralChannel(page: Page, channel: unknown, messages: unknown[]) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  await fulfillChannelHistory(page, messages);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
}

test("human message headers omit the redundant identity-kind badge", async ({ page }) => {
  await openGeneralChannel(page, messageChannel(), [{
    messageId: "message-human-no-kind-badge",
    channelId: "channel-general",
    sequence: 1,
    body: "A human message without a kind label.",
    sentAt: E2E_NOW,
    from: { identityId: "user:human-header", kind: "user", label: "Human sender", userId: "human-header", email: "human@xmatrix.test" },
  }]);
  const row = page.locator(".app-message-row", { hasText: "A human message without a kind label." });
  await expect(row).toBeVisible();
  await expect(row.locator(".app-sender-kind-badge")).toHaveCount(0);
});

test("agent message header shows sender context snapshots", async ({ page }) => {
  await openGeneralChannel(page, messageChannel(), [
    agentMessage({
      messageId: "message-agent-model",
      sequence: 1,
      body: "The implementation is ready for review.",
      instanceId: "instance-codex-1",
      channelInstanceId: "1",
      instanceLabel: "Codex:1",
      from: {
        label: "Codex:1",
        goal: {
          active: true,
          objective: "Show model names in message headers",
          status: "active",
          updatedAt: E2E_NOW,
        },
        gitBranch: "fix-display-model-name",
        model: "gpt-5-codex",
        effort: "xhigh",
        statusChips: [
          { id: "model", label: "Model", value: "gpt-5-codex" },
        ],
      },
    }),
  ]);

  const row = page.locator(".app-message-row", { hasText: "The implementation is ready for review." });
  await expect(row).toBeVisible();
  await expect(row.locator(".app-sender-kind-badge")).toHaveCount(0);
  await expect(row.locator(".app-goal-status-badge")).toHaveText("Goal: active");
  await expect(row.locator(".app-goal-status-badge-shell")).toHaveAttribute(
    "aria-label",
    /Show model names in message headers/
  );
  await expect(row.locator(".app-message-branch-badge")).toContainText("fix-display-model-name");
  // The header reads model and effort as one label.
  const modelChip = row.locator("[data-status-chip='model']");
  await expect(modelChip).toHaveText("gpt-5-codex · xhigh");
  await expect(modelChip).toHaveAttribute("aria-label", "Model: gpt-5-codex · xhigh");
  await expect(row.locator("[data-status-chip='effort']")).toHaveCount(0);
});

test("details rail shows live instance header labels instead of message snapshots", async ({ page }, testInfo) => {
  await openGeneralChannel(page, {
    ...messageChannel(),
    memberPresence: {
      "agent:codex": {
        kind: "agent",
        status: "busy",
        label: "Codex",
        instances: [{
          id: "instance-codex-live",
          channelInstanceId: "1",
          label: "Codex:1",
          connectedAt: E2E_NOW,
          lastSeenAt: E2E_NOW,
          status: "busy",
          model: "gpt-live",
          effort: "high",
          gitBranch: "feat/live-instance-state",
          goal: { active: true, status: "in_progress", objective: "Render live status labels" },
          usage: {
            quotaUsages: [{ label: "5h", percent: 35, resetAt: "4102444800" }],
            quotaSource: "provider_api",
          },
          statusChips: [
            { id: "runtime", label: "Runtime", value: "working" },
            { id: "sandbox", label: "Sandbox", value: "workspace-write" },
          ],
        }],
      },
    },
  }, [
    agentMessage({
      messageId: "message-agent-historical-labels",
      sequence: 1,
      body: "This message keeps the previous header values.",
      instanceId: "instance-codex-live",
      channelInstanceId: "1",
      instanceLabel: "Codex:1",
      from: {
        model: "gpt-history",
        effort: "low",
        gitBranch: "fix/history-snapshot",
        statusChips: [{ id: "runtime", label: "Runtime", value: "waiting" }],
      },
    }),
  ]);

  const liveStatus = page.locator(".app-details [data-live-agent-header-chips]");
  await expect(liveStatus).toBeVisible();
  const liveGoal = liveStatus.locator(".app-goal-status-badge");
  await expect(liveGoal).toHaveText("Goal: in_progress");
  await expect(liveGoal).toHaveClass(/app-goal-status-badge-active/);
  await expect(liveStatus.locator(".app-goal-status-badge-shell")).toHaveAttribute(
    "aria-label",
    /Live status: in_progress/
  );
  const liveBranch = liveStatus.locator("[data-live-agent-branch]");
  await expect(liveBranch).toContainText("feat/live-instance-state");
  await expect(liveBranch).toHaveClass(/app-message-branch-badge/);
  await expect(liveStatus.locator("[data-status-chip='runtime']")).toContainText("working");
  await expect(liveStatus.locator("[data-status-chip='sandbox']")).toContainText("workspace-write");
  await expect(liveStatus.locator("[data-status-chip='model']")).toContainText("gpt-live");
  await expect(liveStatus.locator("[data-status-chip='effort']")).toContainText("high");
  const usageMeter = liveStatus.locator("[data-usage-meter-chip]", { hasText: "5h" });
  const usageFill = usageMeter.locator(".app-usage-meter-fill");
  await expect(usageMeter).toContainText("35%");
  // The meter is ink on the paper, the same as the tags beside it.
  const chipMaterial = (chip: Element) => {
    const style = getComputedStyle(chip);
    return { background: style.backgroundColor, edge: style.boxShadow };
  };
  expect(await usageMeter.evaluate(chipMaterial)).toEqual(
    await liveStatus.locator("[data-status-chip='model']").evaluate(chipMaterial)
  );
  // Hovering a meter floats its tooltip at once (no native title delay), with
  // the reset time, and without moving the chip out from under the pointer.
  const usageTip = page.locator("[data-usage-meter-tip]");
  await expect(usageTip).toHaveCount(0);
  const restingBox = await usageMeter.boundingBox();
  await usageMeter.hover();
  await expect(usageTip).toBeVisible();
  await expect(usageTip).toContainText(/^5h - 35% - resets at .*2100/);
  expect(await usageMeter.boundingBox()).toEqual(restingBox);
  const tipBox = await usageTip.boundingBox();
  expect(tipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.locator(".app-details").screenshot({ path: testInfo.outputPath("details-usage-meter-hover-tip.png") });
  await page.mouse.move(0, 0);
  await expect(usageTip).toHaveCount(0);
  await expect(usageFill).toHaveCSS("position", "absolute");
  const usageGeometry = await usageMeter.evaluate((chip) => {
    const fill = chip.querySelector<HTMLElement>(".app-usage-meter-fill");
    if (!fill) throw new Error("usage meter fill is missing");
    const chipRect = chip.getBoundingClientRect();
    const fillRect = fill.getBoundingClientRect();
    return {
      chipHeight: chipRect.height,
      chipWidth: chipRect.width,
      fillHeight: fillRect.height,
      fillWidth: fillRect.width,
    };
  });
  // The share used fills the label behind its words.
  expect(usageGeometry.fillHeight).toBeGreaterThanOrEqual(usageGeometry.chipHeight - 1);
  expect(usageGeometry.fillWidth / usageGeometry.chipWidth).toBeCloseTo(0.35, 1);
  const screenshotPath = testInfo.outputPath("details-usage-meter-35-percent.png");
  await usageMeter.screenshot({ path: screenshotPath });
  testInfo.attachments.push({
    name: "details usage meter at 35 percent",
    path: screenshotPath,
    contentType: "image/png",
  });
  await expect(liveStatus).not.toContainText("gpt-history");
  await expect(liveStatus).not.toContainText("fix/history-snapshot");
});

test("agent message header does not present a usage-limit snapshot as current state", async ({ page }) => {
  await openGeneralChannel(page, messageChannel(), [
    agentMessage({
      messageId: "message-agent-usage-limit",
      sequence: 1,
      body: "The turn stopped at the previous quota window.",
      instanceId: "instance-codex-expired",
      channelInstanceId: "3",
      instanceLabel: "Codex:3",
      from: {
        label: "Codex:3",
        goal: {
          active: false,
          objective: "Finish the image pipeline",
          status: "usageLimit",
          updatedAt: E2E_NOW,
        },
      },
    }),
  ]);

  const row = page.locator(".app-message-row", { hasText: "The turn stopped at the previous quota window." });
  const goalBadge = row.locator(".app-goal-status-badge");
  await expect(goalBadge).toHaveText("Goal: paused");
  await expect(goalBadge).not.toContainText("Finish the image pipeline");
  await expect(goalBadge).not.toContainText("usageLimit");
  await expect(row.locator(".app-goal-status-badge-shell")).toHaveAttribute(
    "aria-label",
    /Status when sent: usage limit/
  );
});

test("agent usage alerts stop at the provider-reported reset time", async ({ page }) => {
  const quotaUsage = (resetAt: string) => ({
    quotaUsages: [{ label: "5h", percent: 100, resetAt }],
    quotaSource: "provider_api",
  });
  const channel = {
    ...E2E_CHANNEL,
    memberPresence: {
      "agent:codex": {
        kind: "agent",
        status: "online",
        label: "Codex",
        email: "codex@xmatrix.test",
        instances: [
          {
            id: "instance-expired-quota",
            channelInstanceId: "5",
            label: "expired quota",
            connectedAt: E2E_NOW,
            lastSeenAt: E2E_NOW,
            status: "idle",
            usage: quotaUsage("1"),
          },
        ],
      },
      "agent:codex-current": {
        kind: "agent",
        status: "online",
        label: "Current Codex",
        email: "current-codex@xmatrix.test",
        instances: [
          {
            id: "instance-current-quota",
            channelInstanceId: "6",
            label: "current quota",
            connectedAt: E2E_NOW,
            lastSeenAt: E2E_NOW,
            status: "idle",
            usage: quotaUsage("4102444800"),
          },
        ],
      },
    },
  };

  await openGeneralChannel(page, channel, []);

  const expiredQuota = page.locator('.app-agent-work-avatar[aria-label*="expired quota"]');
  const currentQuota = page.locator('.app-agent-work-avatar[aria-label*="current quota"]');
  await expect(expiredQuota).not.toHaveAttribute("aria-label", /Usage limit reached/);
  await expect(currentQuota).toHaveAttribute("aria-label", /Usage limit reached/);

  // The word and the presence dot used to share the top corner, so the dot
  // covered the end of "limit".
  const limitMark = currentQuota.locator(".app-agent-work-limit");
  const presence = currentQuota.locator(".identity-avatar-status");
  await expect(limitMark).toHaveText("limit");
  const separated = await currentQuota.evaluate((node) => {
    const mark = node.querySelector(".app-agent-work-limit")?.getBoundingClientRect();
    const dot = node.querySelector(".identity-avatar-status")?.getBoundingClientRect();
    if (!mark || !dot) return false;
    const overlaps = mark.left < dot.right - 1 && mark.right > dot.left + 1
      && mark.top < dot.bottom - 1 && mark.bottom > dot.top + 1;
    return !overlaps && mark.top >= dot.bottom;
  });
  expect(separated).toBe(true);
  await expect(presence).toBeVisible();

  // The limit heads the Instance's controls in their one panel, in their fixed
  // layer: an in-place card is clipped by the dock's horizontal scroller.
  await currentQuota.hover();
  const actions = currentQuota.locator("xpath=ancestor::*[contains(@class,'app-agent-work-item')][1]")
    .locator(".app-agent-work-actions");
  const toolbar = actions.getByRole("toolbar");
  const limitTip = toolbar.locator('[role="note"]');
  await expect(limitTip).toBeVisible();
  await expect(limitTip).toContainText("Usage limit reached");
  await expect(actions.locator(".app-agent-work-action-menu")).toHaveCount(1);
  await expect(actions).toHaveCSS("position", "fixed");
  const tipBox = await limitTip.boundingBox();
  const toolbarBox = await toolbar.boundingBox();
  const stopBox = await toolbar.locator('[data-action="stop"]').boundingBox();
  // The limit sits above the controls and wraps to their width, not wider.
  expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(stopBox!.y);
  expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width);
  const viewport = page.viewportSize();
  expect(toolbarBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(toolbarBox!.x).toBeGreaterThanOrEqual(0);
  expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(viewport!.width);
  await actions.screenshot({ path: test.info().outputPath("usage-limit-panel.png") });
});

test("agent message header does not derive historical context from live instance", async ({ page }) => {
  const channel = {
    ...E2E_CHANNEL,
    messageCount: 1,
    lastMessageSequence: 1,
    updatedAt: E2E_NOW,
    memberPresence: {
      "agent:codex": {
        kind: "agent",
        status: "offline",
        label: "Codex",
        email: "codex@xmatrix.test",
        instances: [
          {
            id: "instance-codex-live",
            channelInstanceId: "4",
            label: "Codex:4",
            connectedAt: E2E_NOW,
            lastSeenAt: E2E_NOW,
            status: "online",
            goal: {
              active: true,
              objective: "Live goal should not rewrite old message headers",
              status: "active",
              updatedAt: E2E_NOW,
            },
            gitBranch: "live-branch",
            model: "gpt-5-codex",
          },
        ],
      },
    },
  };

  await openGeneralChannel(page, channel, [
    agentMessage({
      messageId: "message-agent-presence-model",
      sequence: 1,
      body: "This came from an older sender snapshot.",
      instanceId: "instance-codex-live",
      channelInstanceId: "4",
      instanceLabel: "Codex:4",
    }),
  ]);

  const row = page.locator(".app-message-row", { hasText: "This came from an older sender snapshot." });
  await expect(row).toBeVisible();
  await expect(row.locator(".app-sender-instance-stale-badge")).toHaveCount(0);
  await expect(row.locator(".app-goal-status-badge")).toHaveCount(0);
  await expect(row.locator(".app-message-branch-badge")).toHaveCount(0);
  await expect(row.locator("[data-status-chip='model'], [data-status-chip='effort']")).toHaveCount(0);
});

test("hub system notices keep the xMatrix identity instead of the owning user's profile", async ({ page }) => {
  await openGeneralChannel(
    page,
    {
      ...messageChannel(),
      memberPresence: {
        "user:owner-legend": {
          kind: "user",
          status: "online",
          label: "Legend",
          email: "legend@xmatrix.test",
          avatarUrl: "https://avatars.xmatrix.test/legend.png",
        },
      },
    },
    [
      {
        messageId: "system:machine-stop-result:e2e",
        channelId: "channel-general",
        sequence: 1,
        // The hub appends this notice under the machine owner's principal.
        body: "Stopped @codex-legend on Devs-MacBook-Pro.local. The Workstation confirmed the process tree is terminated.",
        sentAt: E2E_NOW,
        from: {
          identityId: "user:owner-legend",
          kind: "user",
          label: "xMatrix",
          userId: "owner-legend",
          email: "legend@xmatrix.test",
          avatarUrl: "/brand/xmatrix-management-icon.png",
        },
        metadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true },
      },
    ]
  );

  const row = page.locator(".app-message-row", {
    hasText: "The Workstation confirmed the process tree is terminated.",
  });
  await expect(row).toBeVisible();
  await expect(row.locator(".message-author-avatar img")).toHaveAttribute(
    "src",
    "/brand/xmatrix-management-icon.png"
  );
  await expect(row.locator(".app-sender-kind-badge")).toHaveCount(0);
  await expect(row.locator(".identity-avatar-status")).toHaveCount(0);
});


for (const legacy of [true, false]) test(`cross-Channel Machine badge resolves ${legacy ? "an old exact Instance" : "a stopped sender snapshot"}`, async ({ page }) => {
  const key = { spaceId: E2E_SPACE.id, ownerUserId: "agent-owner", machineId: "machine:server", harness: "codex" };
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [{ ...messageChannel(),
    members: ["agent:codex"], memberPresence: { "agent:codex": { kind: "agent", label: "Codex",
      registration: { ownerUserId: key.ownerUserId, machineId: "machine:laptop", harness: key.harness },
      instances: [{ id: "local:1", channelInstanceId: "1", status: "idle", name: "Codex" }],
    } },
  }] });
  await fixtureJson(page, "registration-catalog", "**/api/xmatrix/spaces/*/agent-registrations", {
    capabilities: [],
    registrations: [{ key, machineName: "fixture-node", ownerName: "Owner",
      ...(legacy ? { live: { machine: { online: true }, running: [
        { instanceId: "origin:1", channelId: "origin", channelInstanceId: "1" },
      ] } } : {}) },
      { key: { ...key, machineId: "machine:laptop" }, machineName: "Laptop",
        live: { machine: { online: true }, running: [
          { instanceId: "local:1", channelId: "channel-general", channelInstanceId: "1" },
        ] } }],
  });
  await fulfillChannelHistory(page, [agentMessage({ messageId: `cross-machine-${legacy}`, sequence: 1,
    body: "The sender works in another Channel.", instanceId: "origin:1", channelInstanceId: "1", instanceLabel: "codex:1",
    from: { originChannelId: "origin", ...(legacy ? {} : { registration: {
      ownerUserId: key.ownerUserId, machineId: key.machineId, harness: key.harness,
    } }) },
  })]);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  const row = page.locator(".app-message-row", { hasText: "The sender works in another Channel." });
  await expect(row.locator(".app-agent-identity-labels")).toContainText("fixture-node");
  await expect(row.locator(".app-agent-identity-labels")).not.toContainText("Unnamed machine");
  await expect(row.locator(".app-agent-identity-labels")).not.toContainText("Laptop");
});
