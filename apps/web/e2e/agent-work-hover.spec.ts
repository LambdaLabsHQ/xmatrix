import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";
import { E2E_CHANNEL, E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

const DESKTOP_HOVER_CONTEXT = {
  deviceScaleFactor: 2,
  hasTouch: false,
  isMobile: false,
  viewport: { height: 800, width: 1280 },
};

test.use(DESKTOP_HOVER_CONTEXT);

const ACTIVE_AGENT_CHANNEL = {
  ...E2E_CHANNEL,
  memberPresence: {
    "agent:codex": {
      kind: "agent",
      status: "busy",
      label: "Codex",
      activity: "Reviewing hover controls",
      instances: [
        {
          id: "instance-codex-1",
          channelInstanceId: "1",
          label: "codex:1",
          connectedAt: E2E_NOW,
          lastSeenAt: E2E_NOW,
          status: "busy",
          activity: "Reviewing hover controls",
          gitBranch: "fix/redesign-hover-interaction",
        },
      ],
    },
  },
};

async function openActiveAgentWorkspace(page: Page) {
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [ACTIVE_AGENT_CHANNEL],
  });
}

async function expectToolbarAttached(avatar: Locator, toolbar: Locator) {
  await expect.poll(async () => {
    const [avatarBox, toolbarBox] = await Promise.all([avatar.boundingBox(), toolbar.boundingBox()]);
    if (!avatarBox || !toolbarBox) return Number.POSITIVE_INFINITY;
    return Math.abs(avatarBox.y - (toolbarBox.y + toolbarBox.height));
  }).toBeLessThanOrEqual(12);
}

for (const mobile of [false, true]) {
  test.describe(`failed-turn controls ${mobile ? "mobile" : "desktop"}`, () => {
    test.use({
      ...(mobile ? E2E_MOBILE_CONTEXT : DESKTOP_HOVER_CONTEXT),
      deviceScaleFactor: 4,
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    });
    test("failed-turn island keeps hover controls beside the avatar and reachable from the status", async ({ page }, testInfo) => {
      const presence = ACTIVE_AGENT_CHANNEL.memberPresence["agent:codex"];
      const instance = presence.instances[0];
      await openWorkspaceWithStubs(page, {
        spaces: [E2E_SPACE],
        channels: [{
          ...ACTIVE_AGENT_CHANNEL,
          memberPresence: {
            "agent:codex": {
              ...presence,
              status: "online",
              instances: [{
                ...instance,
                status: "online",
                usage: {
                  quotaState: "observed",
                  quotaSource: "provider_api",
                  quotaObservedAt: new Date().toISOString(),
                  quotaUsages: [{ label: "5h", usedPercent: 100 }],
                  quotaAccount: { allowed: false },
                },
                runtimeState: { status: "idle", issue: { kind: "failed", sinceMillis: Date.now() - 480_000 } },
              }],
            },
          },
        }],
      });

      if (mobile) {
        await page.locator(".app-mobile-channel-list-pane")
          .getByText(ACTIVE_AGENT_CHANNEL.name || "general", { exact: true }).first().tap();
      }
      const avatar = page.getByRole("button", { name: /Open Codex.*codex:1/ });
      const issue = page.locator(".app-agent-work-dock [data-runtime-issue='failed']");
      const controls = page.locator(".app-agent-work-actions");
      const toolbar = page.getByRole("toolbar", { name: "Controls for codex:1" });
      await expect(avatar.locator(".app-agent-work-limit")).toHaveText("limit");
      if (mobile) await issue.getByRole("button").focus();
      else await issue.hover();
      await expect(controls).toHaveCSS("opacity", "1");
      await expectToolbarAttached(avatar, toolbar);
      await expect(toolbar.getByRole("note")).toHaveText("Usage limit reached: provider refuses requests");
      await toolbar.hover();
      await expect(controls).toHaveCSS("opacity", "1");
      await page.screenshot({ path: testInfo.outputPath("failed-turn-hover.png") });
      await expect(toolbar.getByRole("button", { name: "Reborn codex:1" })).toBeEnabled();
      await toolbar.getByRole("button", { name: "Stop codex:1" }).click();
      await expect(page.getByRole("heading", { name: "Stop agent?" })).toBeVisible();
    });
  });
}

test("agent avatar reveals one compact, keyboard-accessible action toolbar", async ({ page }) => {
  await openActiveAgentWorkspace(page);

  const avatar = page.getByRole("button", { name: /Open Codex.*codex:1/ });
  const controls = page.locator(".app-agent-work-actions");
  const toolbar = page.getByRole("toolbar", { name: "Controls for codex:1" });

  await expect(avatar).toBeVisible();
  await expect(avatar).not.toHaveAttribute("title");
  await expect(controls).toHaveCSS("opacity", "0");

  await avatar.hover();
  await expect(controls).toHaveCSS("opacity", "1");
  await expect(toolbar.locator(".app-agent-work-instance-name")).toHaveText("codex:1");
  await expect(toolbar.getByRole("button", { name: "Reborn codex:1" })).toContainText("Reborn");
  await expect(toolbar.getByRole("button", { name: "Stop codex:1" })).toContainText("Stop");
  await expect(toolbar).toHaveCSS("backdrop-filter", /^(?!none$).+/);

  const [avatarBox, toolbarBox] = await Promise.all([avatar.boundingBox(), toolbar.boundingBox()]);
  expect(avatarBox).not.toBeNull();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox!.width).toBeGreaterThan(toolbarBox!.height * 2);
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(avatarBox!.y);

  const mainBox = await page.locator(".app-main").boundingBox();
  expect(mainBox).not.toBeNull();
  expect(toolbarBox!.x).toBeGreaterThanOrEqual(mainBox!.x + 11);
  expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width - 11);

  const actionMaterials = await toolbar.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => ({
      backdropFilter: getComputedStyle(button).backdropFilter,
      boxShadow: getComputedStyle(button).boxShadow,
    }))
  );
  expect(actionMaterials).toEqual([
    { backdropFilter: "none", boxShadow: "none" },
    { backdropFilter: "none", boxShadow: "none" },
  ]);

  const actionCentersAreInteractive = await toolbar.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2).includes(button);
    })
  );
  expect(actionCentersAreInteractive).toEqual([true, true]);

  await toolbar.hover();
  await expect(controls).toHaveCSS("opacity", "1");

  await avatar.focus();
  await expect(controls).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(toolbar.getByRole("button", { name: "Reborn codex:1" })).toBeFocused();
});

test("stop from the Instance card uses the card address when agent_list is empty", async ({ page }) => {
  await openActiveAgentWorkspace(page);

  const avatar = page.getByRole("button", { name: /Open Codex.*codex:1/ });
  await avatar.hover();
  await page.getByRole("button", { name: "Stop codex:1" }).click();

  await expect(page.getByRole("heading", { name: "Stop agent?" })).toBeVisible();
  await expect(page.getByText("This instance has no channel address to stop.")).toHaveCount(0);
  await expect(page.getByRole("paragraph").filter({ hasText: /^codex:1$/ })).toBeVisible();
});

test("Handoff picks a successor and posts the handoff mention", async ({ page }) => {
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [ACTIVE_AGENT_CHANNEL],
    registrations: ["claude", "codex", "cursor", "gemini", "grok"].map((harness) => ({
      key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "mac-id", harness },
    })),
  });
  await fixtureJson(page, "handoff-send", new RegExp(`/api/xmatrix/channels/${ACTIVE_AGENT_CHANNEL.id}/messages$`, "u"),
    { message: { messageId: "m-handoff" } }, { method: "POST" });

  const avatar = page.getByRole("button", { name: /Open Codex.*codex:1/ });
  const toolbar = page.getByRole("toolbar", { name: "Controls for codex:1" });
  await avatar.hover();
  await toolbar.getByRole("button", { name: "Hand off codex:1" }).click();

  await expect(toolbar.getByText("Hand off codex:1 to")).toBeVisible();
  const successors = toolbar.getByRole("button", { name: /^Hand off codex:1 to/ });
  await expect(successors).toHaveText([/^Auto/, "@claude", "@codex", "@cursor", "@gemini", "@grok"]);
  // Many successors stack in one column instead of widening the toolbar.
  const successorLefts = await successors.evaluateAll((buttons) =>
    buttons.map((button) => Math.round(button.getBoundingClientRect().left)));
  expect(new Set(successorLefts).size).toBe(1);
  const pickerBox = await toolbar.boundingBox();
  expect(pickerBox!.width).toBeLessThan(320);
  await expect(toolbar.getByRole("button", { name: "Stop codex:1" })).toHaveCount(0);

  await toolbar.getByRole("button", { name: "Back to controls" }).click();
  await expect(toolbar.getByRole("button", { name: "Stop codex:1" })).toBeVisible();

  await toolbar.getByRole("button", { name: "Hand off codex:1" }).click();
  await toolbar.getByRole("button", { name: "Hand off codex:1 to a new @claude" }).click();
  await expect.poll(async () => (await fixtureRequestBodies(page, "handoff-send")).map((body) => body.body))
    .toEqual(["@Codex:1:handoff:@claude"]);
});

test("right-side Agent navigation is limited to a flat avatar button", async ({ page }) => {
  await openActiveAgentWorkspace(page);

  const avatar = page.getByRole("button", { name: "Open @Codex:1 instance details" });
  await expect(page.locator(".app-details button.app-detail-agent-row")).toHaveCount(0);
  await expect(avatar).toBeVisible();

  await avatar.hover();
  await expect(avatar).toHaveCSS("backdrop-filter", "none");
  await expect(avatar).toHaveCSS("box-shadow", "none");
  await expect(avatar).toHaveCSS("background-image", "none");
  await expect(avatar).toHaveCSS("transform", "none");

  await avatar.focus();
  await expect(avatar).toBeFocused();
  await expect(avatar).toHaveCSS("outline-style", "solid");
  await expect(avatar).toHaveCSS("outline-width", "2px");
});

test.describe("mobile agent controls", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("visible agent action toolbar stays attached after layout shifts", async ({ page }) => {
    await openActiveAgentWorkspace(page);

    await page
      .locator(".app-mobile-channel-list-pane")
      .getByText(ACTIVE_AGENT_CHANNEL.name || "general", { exact: true })
      .first()
      .tap();

    const avatar = page.getByRole("button", { name: /Open Codex.*codex:1/ });
    const toolbar = page.getByRole("toolbar", { name: "Controls for codex:1" });

    await avatar.focus();
    await expect(toolbar).toBeVisible();

    await page.locator(".app-agent-work-dock").evaluate((dock) => {
      (dock as HTMLElement).style.transform = "translateY(96px)";
    });

    await expectToolbarAttached(avatar, toolbar);
  });

  test("agent Instance control is large enough and clears the floating composer", async ({ page }) => {
    await openActiveAgentWorkspace(page);
    await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");

    const avatar = page.getByRole("button", { name: /Open Codex.*codex:1/ });
    const composer = page.locator(".app-composer");
    await expect(avatar).toBeVisible();
    await expect(composer).toBeVisible();

    const [avatarBox, composerBox] = await Promise.all([avatar.boundingBox(), composer.boundingBox()]);
    expect(avatarBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(avatarBox!.width).toBeGreaterThanOrEqual(48);
    expect(avatarBox!.y + avatarBox!.height).toBeLessThanOrEqual(composerBox!.y - 10);
  });
});
