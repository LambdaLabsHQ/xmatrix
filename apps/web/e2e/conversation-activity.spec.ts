import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_USER_SENDER,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

/* A conversation keeps talk whole and folds progress, without losing who did
   what in which order (docs/design/conversation-activity.md §4). */

test.use(E2E_DESKTOP_CONTEXT);

const at = (minute: number) => new Date(Date.UTC(2026, 6, 1, 18, minute)).toISOString();

const claude = {
  kind: "agent",
  identityId: "agent:claude",
  agentId: "agent:claude",
  agentName: "claude",
  label: "claude:1",
  instanceId: "instance-claude-1",
  userId: "e2e-user",
  email: "",
};
const codex = { ...claude, identityId: "agent:codex", agentId: "agent:codex", agentName: "codex",
  label: "codex:2", instanceId: "instance-codex-2" };
const reviewer = { ...E2E_USER_SENDER, identityId: "user:reviewer", userId: "reviewer", label: "Reviewer" };

let sequence = 0;
function entry(from: object, minute: number, body: string, extra: object = {}) {
  sequence += 1;
  return { messageId: `m-${sequence}`, channelId: "channel-general", sequence, body, sentAt: at(minute),
    from, ...extra };
}
function plan(from: object, minute: number, completed: string[], inProgress?: string) {
  return entry(from, minute, completed.map((step) => `✓ ${step}`).join(" · "), {
    metadata: { xmatrixProvenance: "activity", xmatrixActivity: {
      kind: "plan", completed, ...(inProgress ? { inProgress } : {}),
      steps: [...completed.map((text) => ({ text, status: "completed" })),
        ...(inProgress ? [{ text: inProgress, status: "in_progress" }] : [])] } },
  });
}

function history() {
  sequence = 0;
  return [
    entry(reviewer, 0, "Please ship the page Automations, then tell me when it is released."),
    entry(reviewer, 1, "Stack the CLI on top of PR 2."),
    entry(claude, 20, "Progress: running jscpd, knip and tsc.", { supersededBy: "m-6" }),
    plan(claude, 27, ["jscpd", "knip", "web tsc"], "e2e regression"),
    plan(claude, 28, ["e2e regression 191/191"], "Open PR 2"),
    entry(claude, 29, "The two db cross-space failures fail on main too: a known stale baseline."),
    entry(claude, 29, "↗ Opened pull request LambdaLabsHQ/xmatrix#3043", {
      metadata: { xmatrixProvenance: "activity", xmatrixActivity: { kind: "pull_request",
        repository: "LambdaLabsHQ/xmatrix", number: 3043, url: "https://github.com/LambdaLabsHQ/xmatrix/pull/3043" } },
    }),
    plan(codex, 33, ["merged #3041"]),
    plan(claude, 36, ["CLI"], "Web"),
  ];
}

test("activity folds per run, anyone else's entry breaks the run, and talk stays whole", async ({ page }) => {
  const messages = history();
  await openGeneralChannelWithHistory(page, {
    ...E2E_CHANNEL,
    messageCount: messages.length,
    lastMessageSequence: messages.length,
    updatedAt: at(36),
    memberPresence: {
      "agent:claude": { kind: "agent", status: "busy", label: "claude", instances: [{
        id: "instance-claude-1", channelInstanceId: "1", label: "claude:1", connectedAt: at(0),
        lastSeenAt: at(36), status: "busy", intent: "Writing the Web part" }] },
    },
  }, messages);

  const folds = page.locator(".app-activity-row");
  await expect(folds).toHaveCount(4);
  // claude:1's superseded report and its two plan entries are one run; its
  // finding ends it; its pull request starts a new run that codex:2 ends.
  await expect(folds.nth(0)).toContainText("claude:1");
  await expect(folds.nth(0)).toContainText("✓ e2e regression 191/191");
  await expect(folds.nth(1)).toContainText("↗ LambdaLabsHQ/xmatrix#3043");
  await expect(folds.nth(2)).toContainText("codex:2");
  await expect(folds.nth(3)).toContainText("→ Web");
  await expect(page.getByText("The two db cross-space failures fail on main too")).toBeVisible();

  // A second message moments later from the same person drops the header.
  await expect(page.locator(".app-message-continuation-gutter")).toHaveCount(1);

  // Opening a run shows every entry it stands for, in order.
  await folds.nth(0).getByRole("button").first().click();
  await expect(folds.nth(0).getByText("superseded")).toBeVisible();
  await expect(folds.nth(0).getByText("Progress: running jscpd, knip and tsc.")).toBeVisible();

  // The work dock says what the Instance is on now.
  await expect(page.locator(".app-agent-work-intent")).toContainText("Writing the Web part");

  await page.screenshot({ path: test.info().outputPath("conversation-activity.png"), fullPage: false });
});

/** A channel whose one claude Instance reports `waiting`. */
async function openWaitingChannel(page: Page, waiting: Record<string, unknown>, usage?: Record<string, unknown>) {
  const seen = new Date().toISOString();
  await openGeneralChannelWithHistory(page, {
    ...E2E_CHANNEL,
    messageCount: 1,
    lastMessageSequence: 1,
    updatedAt: seen,
    memberPresence: {
      "agent:claude": { kind: "agent", status: "busy", label: "claude", instances: [{
        id: "instance-claude-1", channelInstanceId: "1", label: "claude:1", connectedAt: seen,
        lastSeenAt: seen, status: "busy", runtimeState: { status: "running", waiting },
        ...(usage ? { usage } : {}) }] },
    },
  }, [entry(reviewer, 0, "Merge it once CI is green.")]);
}

/** True when two boxes share more than a hairline of area. */
function boxesOverlap(a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width - 1 && a.x + a.width > b.x + 1
    && a.y < b.y + b.height - 1 && a.y + a.height > b.y + 1;
}

function runningLoops(decoration: Locator) {
  return decoration.evaluate(node => node.getAnimations().filter(animation =>
    animation.playState === "running" && animation.effect?.getTiming().iterations === Infinity).length);
}

/** Compare painted phases without coupling the owner to CSS or native clocks. */
async function paintedLoopFrames(decoration: Locator, times: [number, number]): Promise<[Buffer, Buffer]> {
  const loops = await decoration.evaluateHandle(node => node.getAnimations().filter(animation =>
    animation.playState === "running" && animation.effect?.getTiming().iterations === Infinity));
  const frames: Buffer[] = [];
  try {
    expect(await loops.evaluate(animations => animations.length)).toBeGreaterThan(0);
    for (const time of times) {
      await loops.evaluate((animations, time) => {
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = time;
        }
      }, time);
      frames.push(await decoration.screenshot({ animations: "allow" }));
    }
    return [frames[0]!, frames[1]!];
  } finally {
    await loops.evaluate(animations => { for (const animation of animations) animation.play(); });
    await loops.dispose();
  }
}

test("a working face pulses, follows motion preferences, and stops its clock when it leaves", async ({ page }) => {
  const space = workingAgentsSpace(1, "decoration-pulse");
  const send = await openWorkingAgentsSpace(page, space, channelHistory(1, "decoration-pulse", () => "Working now"),
    "Working now");
  const dot = page.locator(".app-agent-work-dock .identity-avatar-status");
  await expect(dot).toBeVisible();
  await expect.poll(() => runningLoops(dot)).toBe(1);
  const [bright, dim] = await paintedLoopFrames(dot, [0, 1_000]);
  expect(bright.equals(dim)).toBe(false);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => runningLoops(dot)).toBe(0);
  const resting = await dot.screenshot({ animations: "allow" });
  await page.waitForTimeout(150);
  expect(resting.equals(await dot.screenshot({ animations: "allow" }))).toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => runningLoops(dot)).toBe(1);

  // Keep the real clock and DOM node across the roster update: inspecting a
  // replacement node could miss an animation left alive by its old ref.
  const previous = await dot.evaluateHandle(node => ({ node, animations: node.getAnimations() }));
  const agent = space.agents[0]!;
  send({ type: "channel_updated", channel: { ...space.channels[0], memberPresence: {} } });
  send({ type: "agent_lifecycle", channelId: space.channelId(0), agentId: agent.id,
    instanceId: agent.instances[0]!.id, status: "offline", layer: "agent", ts: new Date().toISOString() });
  await expect(dot).toHaveCount(0);
  await expect.poll(() => previous.evaluate(({ node, animations }) => ({
    connected: node.isConnected, running: animations.some(animation => animation.playState === "running"),
  }))).toEqual({ connected: false, running: false });
  await previous.dispose();
});

test("a waiting Instance grows into an island that says what it waits on and for how long", async ({ page }) => {
  await openWaitingChannel(page, { kind: "tool", label: "Wait for CI on PR #3781", details: ["gh pr checks 3781 --watch"],
    sinceMillis: Date.now() - 8 * 60_000 - 5_000 });

  const island = page.locator(".app-agent-work-island");
  await expect(island).toHaveAttribute("data-waiting", "tool");
  await expect(island).toContainText("Waiting");
  await expect(island).toContainText("CI");
  await expect(island).toContainText("8m");
  await expect(island.locator(".app-agent-work-intent")).toHaveAttribute("aria-label", "Waiting: Wait for CI on PR #3781 · 8m");
  // The words say what it waits on, so the face drops its hollow waiting ring.
  await expect(island.locator(".identity-avatar-status")).toBeHidden();
  const ring = island.locator(".app-agent-work-intent-ring");
  await expect(ring).toBeVisible();
  await expect.poll(() => runningLoops(ring)).toBe(1);
  const [earlyRing, laterRing] = await paintedLoopFrames(ring, [0, 400]);
  expect(earlyRing.equals(laterRing)).toBe(false);

  const disc = await island.locator(".app-agent-work-avatar").boundingBox();
  const face = await island.locator(".identity-avatar-face").boundingBox();
  const box = await island.boundingBox();
  if (!disc || !face || !box) throw new Error("work dock not laid out");
  // The capsule grows out of the avatar: same size as the face, no outer ring,
  // and the disc sits at the island's leading end.
  expect(Math.abs(disc.width - face.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(disc.height - face.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.x - disc.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.height - disc.height)).toBeLessThanOrEqual(1);
  // The capsule is the one glass; the disc and face on it drop their own, so
  // nothing stacks into a ring. The words carry the left-to-right sweep.
  const material = await island.evaluate((node) => {
    const own = getComputedStyle(node);
    const disc = getComputedStyle(node.querySelector(".app-agent-work-avatar")!);
    const face = getComputedStyle(node.querySelector(".identity-avatar-face")!);
    return { islandImage: own.backgroundImage, islandBackdrop: own.backdropFilter,
      discBackdrop: disc.backdropFilter, discShadow: disc.boxShadow, faceBackdrop: face.backdropFilter };
  });
  expect(material.islandImage).not.toContain("url(");
  expect(material.islandBackdrop).not.toBe("none");
  expect(material).toMatchObject({ discBackdrop: "none", discShadow: "none", faceBackdrop: "none" });

  const words = island.locator(".app-agent-work-intent-main > .truncate");
  await expect(words).toHaveText("Wait for CI on PR #3781");
  const wordBox = await words.boundingBox();
  let inkPass = 0;
  const inkFrames = async () => {
    const pass = inkPass++;
    const frames: Buffer[] = [];
    for (const time of [550, 1100]) {
      await words.evaluate((node, at) => {
        for (const animation of node.getAnimations({ subtree: true })) {
          animation.pause();
          animation.currentTime = at;
        }
      }, time);
      frames.push(await words.screenshot({ animations: "allow", path: test.info().outputPath(`ink-${pass}-${time}.png`) }));
    }
    return frames;
  };
  // The illumination moves over stationary, clipped words. Its CSS/SVG
  // mechanism is deliberately free to change without changing this behavior.
  const [earlyInk, middleInk] = await inkFrames();
  expect(earlyInk.equals(middleInk)).toBe(false);
  expect(await words.boundingBox()).toEqual(wordBox);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => runningLoops(ring)).toBe(0);
  const [steadyInk, laterInk] = await inkFrames();
  expect(steadyInk.equals(laterInk)).toBe(true);
  expect(await words.boundingBox()).toEqual(wordBox);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => runningLoops(ring)).toBe(1);

  await page.locator(".app-agent-work-dock").screenshot({ path: test.info().outputPath("waiting-island.png") });
});

test("off-strip work islands rest and resume as scrolling brings them into view", async ({ page }) => {
  const space = workingAgentsSpace(10, "island-scroll", {
    focusedInstances: 10, intent: "Review channel rendering and message performance",
  });
  await openWorkingAgentsSpace(page, space, channelHistory(40, "island-scroll", row => `Work message ${row}`),
    "Work message 40");
  const strip = page.locator(".app-agent-work-scroller");
  const items = strip.locator(":scope > .app-agent-work-item");
  await expect(items).toHaveCount(10);
  const running = (index: number) => items.nth(index).evaluate(node =>
    node.getAnimations({ subtree: true }).filter(animation => animation.playState === "running" &&
      animation.effect?.getTiming().iterations === Infinity).length);
  const ringRunning = (index: number) => runningLoops(items.nth(index).locator(".app-agent-work-intent-ring"));
  const ink = (index: number) => items.nth(index).locator(".app-agent-work-intent-ink");
  const inkClocks = (index: number) => ink(index).evaluate(node => node.getAnimations({ subtree: true }).map(animation => ({
    state: animation.playState, pending: animation.pending,
    currentTime: typeof animation.currentTime === "number" ? animation.currentTime : null,
    startTime: typeof animation.startTime === "number" ? animation.startTime : null,
  })));
  const expectInkClock = async (index: number, state: "running" | "paused") => {
    await expect.poll(() => inkClocks(index)).toEqual([0, 1].map(() => ({
      state, pending: false, currentTime: expect.any(Number),
      startTime: state === "running" ? expect.any(Number) : null,
    })));
    const clocks = await inkClocks(index);
    expect(clocks[0]!.startTime).toBe(clocks[1]!.startTime);
    expect(clocks[0]!.currentTime).toBe(clocks[1]!.currentTime);
    return clocks;
  };
  const expectActiveEnd = async (visible: number, clipped: number) => {
    await expect.poll(() => running(visible)).toBeGreaterThan(0);
    await expect.poll(() => running(clipped)).toBe(0);
    await expect.poll(() => ringRunning(visible)).toBe(1);
    await expect.poll(() => ringRunning(clipped)).toBe(0);
  };
  await expectActiveEnd(0, 9);
  await expectInkClock(0, "running");
  const firstInk = await ink(0).evaluateHandle(node => ({ node, animations: node.getAnimations({ subtree: true }) }));
  const stripBox = await strip.boundingBox();
  const lastBox = await items.last().boundingBox();
  if (!stripBox || !lastBox) throw new Error("work strip is not laid out");
  expect(lastBox.x).toBeGreaterThanOrEqual(stripBox.x + stripBox.width);

  // Reveal half of the last timer. A partially painted decoration runs; an
  // entirely clipped one rests. The strip keeps its overflowing controls.
  await strip.evaluate(node => {
    const ring = node.lastElementChild!.querySelector(".app-agent-work-intent-ring")!.getBoundingClientRect();
    node.scrollLeft += ring.right - node.getBoundingClientRect().left - node.clientWidth - ring.width / 2;
  });
  await expectActiveEnd(9, 0);
  // The previously visible pair keeps one held phase while the strip paints
  // twice. The last island may create its clocks only on this first reveal.
  const heldInk = await expectInkClock(0, "paused");
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }));
  expect(await inkClocks(0)).toEqual(heldInk);
  await expectInkClock(9, "running");
  const partial = await items.last().boundingBox();
  expect(partial!.x).toBeLessThan(stripBox.x + stripBox.width);
  expect(partial!.x + partial!.width).toBeGreaterThan(stripBox.x + stripBox.width);
  await items.last().locator(".app-agent-work-avatar").hover();
  await expect(items.last().locator(".app-agent-work-actions")).toHaveCSS("visibility", "visible");

  await page.mouse.move(0, 0);
  await strip.evaluate(node => { node.scrollLeft = 0; });
  await expectActiveEnd(0, 9);
  const resumedInk = await expectInkClock(0, "running");
  expect(resumedInk[0]!.currentTime!).toBeGreaterThanOrEqual(heldInk[0]!.currentTime!);
  expect(await firstInk.evaluate(({ node, animations }) => {
    const current = node.getAnimations({ subtree: true });
    return node.isConnected && current.length === animations.length && current.every((animation, index) => animation === animations[index]);
  })).toBe(true);
  await firstInk.dispose();
});

test("a usage limit sits on the face, clear of the island's words", async ({ page }) => {
  await openWaitingChannel(page, { kind: "background", label: "1 task", sinceMillis: Date.now() - 5 * 60_000 }, {
    quotaUsages: [{ label: "5h", percent: 100, resetAt: "4102444800" }],
    quotaSource: "provider_api",
  });

  const island = page.locator(".app-agent-work-island");
  const mark = island.locator(".app-agent-work-limit");
  const status = island.locator(".identity-avatar-status");
  const words = island.locator(".app-agent-work-intent");
  await expect(mark).toHaveText("limit");
  // Waiting, the words say so; the face carries no status mark beside the limit.
  await expect(status).toBeHidden();
  const markBox = await mark.boundingBox();
  const wordsBox = await words.boundingBox();
  const faceBox = await island.locator(".identity-avatar-face").boundingBox();
  if (!markBox || !wordsBox || !faceBox) throw new Error("limit marks not laid out");
  expect(boxesOverlap(markBox, wordsBox)).toBe(false);
  // The mark stays on the face. The capsule to the right keeps its words.
  expect(markBox.x).toBeGreaterThanOrEqual(faceBox.x - 4);
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(faceBox.x + faceBox.width + 4);
  await page.locator(".app-agent-work-dock").screenshot({
    path: test.info().outputPath("work-dock-limit-island.png"),
  });
});

test("three limited Instances keep the limit word under the face and the status dot on the corner", async ({ page }) => {
  const seen = new Date().toISOString();
  const usage = {
    quotaUsages: [{ label: "5h", percent: 100, resetAt: "4102444800" }],
    quotaSource: "provider_api",
  };
  await openGeneralChannelWithHistory(page, {
    ...E2E_CHANNEL,
    messageCount: 1,
    lastMessageSequence: 1,
    updatedAt: seen,
    memberPresence: {
      "agent:claude": {
        kind: "agent", status: "online", label: "claude", avatarUrl: "/agent-vendors/claude.svg",
        instances: [1, 2, 3].map((number) => ({
          id: `instance-claude-${number}`, channelInstanceId: String(number), label: `claude:${number}`,
          connectedAt: seen, lastSeenAt: seen, status: "idle", usage,
        })),
      },
    },
  }, [entry(reviewer, 0, "Three limited instances.")]);

  const discs = page.locator(".app-agent-work-avatar");
  await expect(discs).toHaveCount(3);
  for (const disc of await discs.all()) {
    const mark = disc.locator(".app-agent-work-limit");
    const dot = disc.locator(".identity-avatar-status");
    await expect(mark).toHaveText("limit");
    const markBox = await mark.boundingBox();
    const dotBox = await dot.boundingBox();
    if (!markBox || !dotBox) throw new Error("limit marks not laid out");
    expect(boxesOverlap(markBox, dotBox)).toBe(false);
    expect(markBox.y).toBeGreaterThanOrEqual(dotBox.y + dotBox.height - 1);
  }
  await page.locator(".app-agent-work-dock").screenshot({
    path: test.info().outputPath("work-dock-limit-discs.png"),
  });
});

test("the island's words and the face each show their own card above the item, in one chrome", async ({ page }) => {
  await openWaitingChannel(page, { kind: "background", label: "2 tasks",
    details: ["Wait for CI on PR #3781", "Run the web e2e suite"], sinceMillis: Date.now() - 3 * 60_000 });

  const item = page.locator(".app-agent-work-item");
  const actions = item.locator(".app-agent-work-actions");
  // The words: what it waits on in particular, and not the Instance's controls.
  await item.locator(".app-agent-work-intent").hover();
  const card = actions.locator('.app-agent-work-action-menu[data-mode="card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("2 tasks");
  await expect(card).toContainText("Wait for CI on PR #3781");
  await expect(card).toContainText("Run the web e2e suite");
  await expect(actions.locator('[role="toolbar"]')).toHaveCount(0);
  const cardBox = await card.boundingBox();
  const islandBox = await item.locator(".app-agent-work-island").boundingBox();
  if (!cardBox || !islandBox) throw new Error("card not laid out");
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(islandBox.y);
  await page.locator(".app-agent-work-dock").screenshot({ path: test.info().outputPath("waiting-card.png") });

  // The face: the Instance's controls, in the same chrome, also above.
  await item.locator(".app-agent-work-avatar").hover();
  const toolbar = actions.locator('[role="toolbar"]');
  await expect(toolbar).toBeVisible();
  await expect(actions.locator('[data-mode="card"]')).toHaveCount(0);
  const toolbarBox = await toolbar.boundingBox();
  if (!toolbarBox) throw new Error("toolbar not laid out");
  expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(islandBox.y);
  const chrome = (selector: string) => actions.locator(selector).evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, radius: style.borderRadius, shadow: style.boxShadow };
  });
  const toolbarChrome = await chrome('[role="toolbar"]');
  await item.locator(".app-agent-work-intent").hover();
  expect(await chrome('[data-mode="card"]')).toEqual(toolbarChrome);
});
