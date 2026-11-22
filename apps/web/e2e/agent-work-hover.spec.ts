import { FIXTURE_AGENT_REGISTRATION } from "./workspace-fixtures";
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
    "agent:codex": { registration: FIXTURE_AGENT_REGISTRATION,
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

test("pressing the avatar morphs its capsule up and right into the trace", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openActiveAgentWorkspace(page);
  const avatar = page.getByRole("button", { name: /Open Codex.*codex:1/ });
  const morph = page.locator(".app-agent-work-morph");
  const panel = page.getByRole("dialog");

  await avatar.click();
  // The Trace is inside the capsule's own glass, not a window of its own,
  // and the conversation keeps no overlay.
  await expect(morph.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".app-agent-instance-overlay")).toHaveCount(0);
  // The glass grew up and right out of the capsule: its bottom-left corner is
  // the capsule's, and the capsule's controls sit beside the face on its row.
  await page.mouse.move(5, 5);
  await expect.poll(async () => {
    const [avatarBox, morphBox, panelBox] = await Promise.all([avatar.boundingBox(), morph.boundingBox(), panel.boundingBox()]);
    if (!avatarBox || !morphBox || !panelBox) return null;
    return {
      left: Math.round(morphBox.x - avatarBox.x),
      bottom: Math.round(morphBox.y + morphBox.height - (avatarBox.y + avatarBox.height)),
      grewUp: panelBox.y + panelBox.height <= avatarBox.y + 1,
      grewRight: morphBox.width > avatarBox.width * 4,
    };
  }).toEqual({ left: 0, bottom: 0, grewUp: true, grewRight: true });
  await expect(page.getByRole("toolbar", { name: "Controls for codex:1" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("dock-trace-morph.png") });

  // The same item folds it back, as does a press outside or Escape.
  await avatar.click();
  await expect(panel).toHaveCount(0);
  await avatar.click();
  await expect(panel).toBeVisible();
  await page.locator(".composer-textarea").first().click();
  await expect(panel).toHaveCount(0);
  await avatar.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
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

test("Handoff picker supports choosing machine, model and effort parameters", async ({ page }) => {
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [ACTIVE_AGENT_CHANNEL],
    registrations: [
      {
        key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "mac-laptop", harness: "claude" },
        machineName: "Laptop",
        models: ["claude-opus-4-6"],
        modelCatalog: [{ model: "claude-opus-4-6", efforts: [{ value: "high" }, { value: "max" }] }],
      },
      {
        key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "mac-server", harness: "codex" },
        machineName: "Server",
        models: ["gpt-5.4"],
        modelCatalog: [{ model: "gpt-5.4", efforts: [{ value: "medium" }] }],
      },
    ],
  });
  const { toolbar } = await hoverCodexControlsWithSend(page, "handoff-params");
  await toolbar.getByRole("button", { name: "Hand off codex:1" }).click();
  await toolbar.getByRole("button", { name: "Handoff parameters" }).click();

  await toolbar.getByRole("button", { name: "Laptop" }).click();
  await toolbar.getByRole("button", { name: "claude-opus-4-6" }).click();
  await toolbar.getByRole("button", { name: "high" }).click();
  await toolbar.getByRole("button", { name: "Back to handoff targets" }).click();

  await expect(toolbar.getByRole("button", { name: "Remove machine:Laptop" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Remove model:claude-opus-4-6" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Remove effort:high" })).toBeVisible();
  // Only compatible successors remain under the chosen parameters.
  await expect(toolbar.getByRole("button", { name: /^Hand off codex:1 to/ })).toHaveText([/^Auto/, "@claude"]);

  await toolbar.getByRole("button", { name: "Hand off codex:1 to a new @claude" }).click();
  await toolbar.getByRole("button", { name: "Confirm hand off codex:1 to a new @claude" }).click();
  await expect.poll(async () => (await fixtureRequestBodies(page, "handoff-params")).map((body) => body.body))
    .toEqual(["@Codex:1:handoff:@claude machine:Laptop model:claude-opus-4-6 effort:high"]);
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

  async function openMobileChannelWithSend(
    page: Page,
    key: string,
    harnesses: readonly string[],
    channels: (typeof ACTIVE_AGENT_CHANNEL)[] = [ACTIVE_AGENT_CHANNEL],
  ) {
    await openWorkspaceWithStubs(page, {
      spaces: [E2E_SPACE],
      channels,
      registrations: harnesses.map((harness) => ({
        key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "mac-id", harness },
      })),
    });
    await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
    await fixtureJson(page, key, new RegExp(`/api/xmatrix/channels/${ACTIVE_AGENT_CHANNEL.id}/messages$`, "u"),
      { message: { messageId: `m-${key}` } }, { method: "POST" });
  }

  test("Handoff and Stop second confirmation survive WebKit button blur before click", async ({ page }) => {
    // WebKit (iOS WKWebView / Safari) does not focus `<button>` on touch:
    // tapping a button while another inside the item holds focus blurs the
    // focused button with `relatedTarget === null` before `click`.
    await page.addInitScript(() => {
      document.addEventListener("pointerdown", (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest?.("button") && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
          document.activeElement.blur();
        }
      }, true);
    });
    await openMobileChannelWithSend(page, "mobile-confirm-send", ["claude", "codex", "gemini"]);

    const avatar = page.getByRole("button", { name: /Open Codex.*codex:1/ });
    const toolbar = page.getByRole("toolbar", { name: "Controls for codex:1" });
    await avatar.tap();
    await expect(toolbar).toBeVisible();

    // Handoff focuses the first successor row; tapping @claude blurs it before click.
    await toolbar.getByRole("button", { name: "Hand off codex:1" }).tap();
    await expect(toolbar.getByText("Hand off codex:1 to")).toBeVisible();
    await toolbar.getByRole("button", { name: "Hand off codex:1 to a new @claude" }).tap();
    const confirmHandoff = toolbar.getByRole("button", { name: "Confirm hand off codex:1 to a new @claude" });
    await expect(confirmHandoff).toHaveText("Confirm");
    expect(await fixtureRequestBodies(page, "mobile-confirm-send")).toEqual([]);
    await confirmHandoff.tap();
    await expect.poll(async () => (await fixtureRequestBodies(page, "mobile-confirm-send")).map((body) => body.body))
      .toEqual(["@Codex:1:handoff:@claude"]);

    // Close trace and long-press avatar: Stop opens armed & focused, and tapping Confirm still sends.
    await page.locator(".composer-textarea").first().tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const box = (await avatar.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }],
    });
    await page.waitForTimeout(550);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const confirmStop = toolbar.getByRole("button", { name: "Confirm stop codex:1" });
    await expect(confirmStop).toBeVisible();
    await confirmStop.tap();
    await expect.poll(async () => (await fixtureRequestBodies(page, "mobile-confirm-send")).map((body) => body.body))
      .toEqual(["@Codex:1:handoff:@claude", expect.stringMatching(/^@codex:1:stop$/iu)]);
  });

  test("a second dock Agent stacks controls above its avatar so Handoff and Stop stay tappable", async ({ page }) => {
    const base = ACTIVE_AGENT_CHANNEL.memberPresence["agent:codex"];
    const first = base.instances[0];
    await openMobileChannelWithSend(page, "mobile-second-send", ["claude", "codex"], [{
      ...ACTIVE_AGENT_CHANNEL,
      memberPresence: {
        "agent:codex": {
          ...base,
          instances: [
            { ...first, runtimeState: { status: "busy", waiting: { kind: "tool", label: "Running tests", sinceMillis: Date.now() - 20_000 } } },
            { ...first, id: "instance-codex-2", channelInstanceId: "2", label: "codex:2" },
          ],
        },
      },
    }]);

    const secondAvatar = page.getByRole("button", { name: /Open Codex.*codex:2/ });
    const toolbar = page.getByRole("toolbar", { name: "Controls for codex:2" });
    await secondAvatar.tap();
    await expect(toolbar).toBeVisible();

    const stopBtn = toolbar.getByRole("button", { name: "Stop codex:2" });
    const handoffBtn = toolbar.getByRole("button", { name: "Hand off codex:2" });
    for (const button of [handoffBtn, stopBtn]) {
      const hitTarget = await button.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return Boolean(top && (el === top || el.contains(top)));
      });
      expect(hitTarget).toBe(true);
    }

    await stopBtn.tap();
    const confirmStop = toolbar.getByRole("button", { name: "Confirm stop codex:2" });
    await expect(confirmStop).toHaveText("Confirm");
    await confirmStop.tap();
    await expect.poll(async () => (await fixtureRequestBodies(page, "mobile-second-send")).map((body) => body.body))
      .toEqual([expect.stringMatching(/^@codex:2:stop$/iu)]);
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
