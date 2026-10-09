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
      await expect(controls).toHaveCSS("visibility", "visible");
      await expectToolbarAttached(avatar, toolbar);
      await expect(toolbar.getByRole("note")).toHaveText("Usage limit reached: provider refuses requests");
      await toolbar.hover();
      await expect(controls).toHaveCSS("visibility", "visible");
      await page.screenshot({ path: testInfo.outputPath("failed-turn-hover.png") });
      await expect(toolbar.getByRole("button", { name: "Reborn codex:1" })).toBeEnabled();
      await toolbar.getByRole("button", { name: "Stop codex:1" }).click();
      await expect(toolbar.getByRole("button", { name: "Confirm stop codex:1" })).toBeVisible();
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
  await expect(controls).toHaveCSS("visibility", "hidden");

  await avatar.hover();
  await expect(controls).toHaveCSS("visibility", "visible");
  await expect(toolbar.locator(".app-agent-work-instance-name")).toHaveText("codex:1");
  await expect(toolbar.getByRole("button", { name: "Reborn codex:1" })).toContainText("Reborn");
  await expect(toolbar.getByRole("button", { name: "Stop codex:1" })).toContainText("Stop");
  // The glass is the panel the capsule grows into, not the toolbar inside it.
  await expect(controls.locator(".app-agent-work-morph")).toHaveCSS("backdrop-filter", /^(?!none$).+/);

  const [avatarBox, toolbarBox] = await Promise.all([avatar.boundingBox(), toolbar.boundingBox()]);
  expect(avatarBox).not.toBeNull();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox!.width).toBeGreaterThan(toolbarBox!.height * 2);
  // A bare disc stretches right: the controls sit beside the face, on its line.
  expect(toolbarBox!.x).toBeGreaterThanOrEqual(avatarBox!.x + avatarBox!.width - 1);
  expect(Math.abs((toolbarBox!.y + toolbarBox!.height / 2) - (avatarBox!.y + avatarBox!.height / 2))).toBeLessThanOrEqual(2);

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
  await expect(controls).toHaveCSS("visibility", "visible");

  await avatar.focus();
  await expect(controls).toHaveCSS("visibility", "visible");
  await page.keyboard.press("Tab");
  await expect(toolbar.getByRole("button", { name: "Reborn codex:1" })).toBeFocused();
});

test("Stop asks in place and posts the card's address on the second press", async ({ page }) => {
  await openActiveAgentWorkspace(page);
  const { avatar, toolbar } = await hoverCodexControlsWithSend(page, "stop-send");
  await toolbar.getByRole("button", { name: "Stop codex:1" }).click();

  // The first press only arms the button; nothing is sent and no dialog opens.
  const confirm = toolbar.getByRole("button", { name: "Confirm stop codex:1" });
  await expect(confirm).toHaveText("Confirm");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await fixtureRequestBodies(page, "stop-send")).toEqual([]);

  // Leaving the controls disarms it.
  await page.mouse.move(5, 5);
  await avatar.hover();
  await expect(toolbar.getByRole("button", { name: "Stop codex:1" })).toHaveText("Stop");

  await toolbar.getByRole("button", { name: "Stop codex:1" }).click();
  await confirm.click();
  await expect(page.getByText("This instance has no channel address to stop.")).toHaveCount(0);
  await expect.poll(async () => (await fixtureRequestBodies(page, "stop-send")).map((body) => body.body))
    .toEqual([expect.stringMatching(/^@codex:1:stop$/iu)]);
});

test("Reborn asks in place and posts the reborn mention on the second press", async ({ page }) => {
  // Colours are read at once, so skip the 120ms tint transition.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openActiveAgentWorkspace(page);
  const { toolbar } = await hoverCodexControlsWithSend(page, "reborn-send");
  await toolbar.getByRole("button", { name: "Reborn codex:1" }).click();

  const confirm = toolbar.getByRole("button", { name: "Confirm reborn codex:1" });
  await expect(confirm).toHaveText("Confirm");
  expect(await fixtureRequestBodies(page, "reborn-send")).toEqual([]);
  // An armed Reborn wears Stop's armed colour, not its own hover tint.
  const paint = (button: Locator) => button.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.color, style.backgroundColor];
  });
  const armedRebornPaint = await paint(confirm);

  // Arming Stop disarms Reborn: one armed control at a time.
  await toolbar.getByRole("button", { name: "Stop codex:1" }).click();
  await expect(toolbar.getByRole("button", { name: "Reborn codex:1" })).toHaveText("Reborn");
  expect(await paint(toolbar.getByRole("button", { name: "Confirm stop codex:1" }))).toEqual(armedRebornPaint);

  await toolbar.getByRole("button", { name: "Reborn codex:1" }).click();
  await confirm.click();
  await expect.poll(async () => (await fixtureRequestBodies(page, "reborn-send")).map((body) => body.body))
    .toEqual([expect.stringMatching(/^@codex:1:reborn$/iu)]);
});

/** Records Channel sends under `key` and opens codex:1's controls. */
async function hoverCodexControlsWithSend(page: Page, key: string) {
  await fixtureJson(page, key, new RegExp(`/api/xmatrix/channels/${ACTIVE_AGENT_CHANNEL.id}/messages$`, "u"),
    { message: { messageId: `m-${key}` } }, { method: "POST" });
  const avatar = page.getByRole("button", { name: /Open Codex.*codex:1/ });
  const toolbar = page.getByRole("toolbar", { name: "Controls for codex:1" });
  await avatar.hover();
  return { avatar, toolbar };
}

test("Handoff picks a successor and posts the handoff mention", async ({ page }) => {
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [ACTIVE_AGENT_CHANNEL],
    registrations: ["claude", "codex", "cursor", "gemini", "grok"].map((harness) => ({
      key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "mac-id", harness },
    })),
  });
  const { toolbar } = await hoverCodexControlsWithSend(page, "handoff-send");
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
  // The successor asks in place like Stop before anything is sent.
  const confirm = toolbar.getByRole("button", { name: "Confirm hand off codex:1 to a new @claude" });
  await expect(confirm).toHaveText("Confirm");
  expect(await fixtureRequestBodies(page, "handoff-send")).toEqual([]);
  await confirm.click();
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

    // A bare disc stretches right, so its controls stay on the face's line.
    await expect.poll(async () => {
      const [avatarBox, toolbarBox] = await Promise.all([avatar.boundingBox(), toolbar.boundingBox()]);
      if (!avatarBox || !toolbarBox) return Number.POSITIVE_INFINITY;
      return Math.abs((avatarBox.y + avatarBox.height / 2) - (toolbarBox.y + toolbarBox.height / 2));
    }).toBeLessThanOrEqual(2);
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

test("a stretching disc pushes the Instances after it aside", async ({ page }) => {
  const instance = ACTIVE_AGENT_CHANNEL.memberPresence["agent:codex"].instances[0];
  const idle = (n: number) => ({ ...instance, id: `instance-codex-${n}`, channelInstanceId: String(n), label: `codex:${n}`,
    status: "online", activity: undefined });
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [{ ...ACTIVE_AGENT_CHANNEL, memberPresence: { "agent:codex": {
      ...ACTIVE_AGENT_CHANNEL.memberPresence["agent:codex"], status: "online", activity: undefined, instances: [idle(1), idle(2)] } } }],
  });
  const first = page.getByRole("button", { name: /Open Codex.*codex:1/ });
  const second = page.getByRole("button", { name: /Open Codex.*codex:2/ });
  const restingLeft = (await second.boundingBox())!.x;
  await first.hover();
  const toolbar = page.getByRole("toolbar", { name: "Controls for codex:1" });
  await expect(toolbar).toBeVisible();
  await expect.poll(async () => {
    const [toolbarBox, secondBox] = await Promise.all([toolbar.boundingBox(), second.boundingBox()]);
    return toolbarBox && secondBox ? secondBox.x - (toolbarBox.x + toolbarBox.width) : -1;
  }).toBeGreaterThanOrEqual(0);
  await page.mouse.move(5, 5);
  await expect.poll(async () => Math.round((await second.boundingBox())!.x)).toBe(Math.round(restingLeft));
});
