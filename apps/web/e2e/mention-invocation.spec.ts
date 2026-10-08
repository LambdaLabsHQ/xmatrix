import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, E2E_USER_SENDER,
  fixtureJson, fixtureRequestBodies, fixtureRequests, installWorkspaceStubs } from "./workspace-fixtures";

const messageId = "message-invocations";
const source = "@codex repo:LambdaLabsHQ/xmatrix review this; @claude repo:LambdaLabsHQ/xmatrix check tests. @auto model:reviewer check coverage.";
const launch = (name: string, kind: string) => ({
  launchId: `launch:${name}`, channelId: E2E_CHANNEL.id, sourceMessageId: messageId,
  targetName: name, runId: `run:${name}`, instanceId: `instance:${name}`,
  launchKind: kind, state: "connected", attempt: 0, retryable: false, createdAt: E2E_NOW,
  updatedAt: E2E_NOW, preparedAt: E2E_NOW, commandDurableAt: E2E_NOW, admittedAt: E2E_NOW,
  spawnedAt: E2E_NOW, connectedAt: E2E_NOW,
});
const codex = { ...launch("codex", "registration"), sourceMention: "@codex repo:LambdaLabsHQ/xmatrix",
  activity: { runStatus: "running", phase: "relay_register_retrying", updatedAt: E2E_NOW, hostName: "Workstation", connectionRetry: { attempt: 7 } } };
const claude = { ...launch("claude", "registration"), sourceMention: "@claude repo:LambdaLabsHQ/xmatrix",
  firstReplyAt: E2E_NOW };

const initialExecution = (state: string) => ({ id: "initial-execution", executionId: "initial-execution", revision: 2,
  sourceMessageId: messageId, sourceEntityVersion: 1, sourceInputVersion: 1, sourceBodyHash: "a".repeat(64),
  channelId: E2E_CHANNEL.id, runId: codex.runId, instanceId: codex.instanceId,
  state, inputDisposition: "submitted", startedAt: E2E_NOW, updatedAt: E2E_NOW, observedAt: E2E_NOW, runStatus: "running",
  ...(state === "completed" ? { finishedAt: E2E_NOW } : {}) });

const rejection = { invocationId: "rejected:reviewer", channelId: E2E_CHANNEL.id, sourceMessageId: messageId,
  sourceMention: "@auto model:reviewer", targetRef: "auto", code: "workspace_required",
  message: "Choose an absolute working directory or a repository for this invocation.",
  rejectedAt: E2E_NOW, evidenceExpiresAt: "2099-01-01T00:00:00Z" };

const reborn = { schemaVersion: 1, kind: "reborn", channelId: E2E_CHANNEL.id, sourceMessageId: messageId,
  sourceMessageVersion: 1, sourceMention: "@Alpha:1:reborn", sourceName: "Alpha",
  sourceOrdinal: 1, sourceInstanceId: "instance-alpha", sourceRunId: "prior-alpha", targetInstanceId: "instance-alpha",
  targetName: "Alpha", runId: "successor-alpha", createdAt: E2E_NOW,
  activity: { runStatus: "running", phase: "relay_register_retrying", updatedAt: E2E_NOW, hostName: "Workstation" } };
const handoff = { ...reborn, kind: "handoff", sourceMention: "@Beta:2:handoff:@Gamma",
  sourceName: "Beta", sourceOrdinal: 2, sourceInstanceId: "instance-beta", sourceRunId: "prior-beta",
  targetInstanceId: "instance-gamma", targetName: "Gamma", runId: "successor-gamma",
  predecessorExitedAt: E2E_NOW, handoffFencedAt: E2E_NOW,
  activity: { ...reborn.activity, phase: "turn_running", startupSteps: [{ phase: "runtime_ready", at: E2E_NOW }] } };

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
async function installInvocationFixture(page: Page, launches: unknown[], body = source, continuations: unknown[] = []) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [{ ...E2E_CHANNEL, messageCount: 1, historyHeadSequence: 1 }] });
  await fixtureJson(page, "invocation-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [{ messageId, channelId: E2E_CHANNEL.id, sequence: 1, body,
      sentAt: E2E_NOW, from: E2E_USER_SENDER }], hasMore: false,
  });
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", { launches, rejections: [rejection], continuations });
}

test("each mention has independent live progress and a keyboard-accessible timeline", async ({ page }) => {
  await page.clock.install({ time: new Date(E2E_NOW) });
  await installInvocationFixture(page, [codex, claude]);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const chips = page.locator(".app-mention-invocation");
  await expect(chips).toHaveCount(3);
  await expect(page.getByText(/\d+ agents? · \d+ connected · \d+ failed/)).toHaveCount(0);
  // Startup shows the stage in progress, not "Starting" beside that stage.
  await expect(chips.nth(0)).toContainText("Connecting");
  await expect(chips.nth(0)).not.toContainText("Starting");
  await expect(chips.nth(1)).toContainText("Started");
  await expect(chips.nth(2)).toContainText("Failed");
  // The chip shows the whole expression as written, never the name alone,
  // and never clips it: the lifecycle and workspace are the author's words.
  await expect(chips.nth(0).locator(".app-mention-chip-label")).toHaveText("@codex repo:LambdaLabsHQ/xmatrix");
  await expect(chips.nth(1).locator(".app-mention-chip-label")).toHaveText("@claude repo:LambdaLabsHQ/xmatrix");
  await expect(chips.nth(2).locator(".app-mention-chip-label")).toHaveText("@auto model:reviewer");
  await expect(chips.nth(0).locator(".app-mention-chip-label")).toHaveCSS("text-overflow", "clip");
  await expect(chips.nth(0).locator(".app-mention-chip-label")).toHaveCSS("white-space", "normal");
  await chips.nth(2).click();
  await expect(page.getByRole("dialog")).toContainText("No new process was started");
  await expect(page.getByRole("dialog")).toContainText("Choose an absolute working directory");
  await page.keyboard.press("Escape");
  await chips.nth(0).scrollIntoViewIfNeeded();
  await chips.nth(0).hover();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("Workstation");
  await expect(detail).toHaveAttribute("data-material", "liquid-glass-card");
  await page.clock.runFor(100);
  await expect(detail).toHaveCSS("backdrop-filter", /blur\(.+url\(.+xm-lens-.+saturate\(/);
  await expect(detail.locator("[data-material^=liquid-glass]")).toHaveCount(0);
  await expect(detail).toContainText("Connection attempt 7.");
  const startup = detail.getByRole("list", { name: "Invocation progress" });
  await expect(startup.locator("li[data-state=current]")).toHaveText(/^Connecting$/);
  await expect(startup).not.toContainText("Joined channel");
  await expect(startup.locator("li", { hasText: "Process started" })).toHaveAttribute("data-state", "done");
  await detail.hover();
  await expect(detail).toBeVisible();
  await page.screenshot({ path: "test-results/mention-invocation-desktop.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await chips.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog").locator("li", { hasText: "Reasoning started" })).toHaveAttribute("data-state", "done");
  // The open popover can cover the next line, so switch by keyboard.
  await chips.nth(2).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toContainText("No new process was started");
  await page.keyboard.press("Escape");
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [{ ...codex, firstReplyAt: E2E_NOW, activity: { ...codex.activity, phase: "turn_running", wrapperReadyAt: E2E_NOW,
      startupSteps: ["cwd_ready", "relay_registered", "runtime_ready", "turn_running"].map(phase => ({ phase, at: E2E_NOW })) } }, claude],
    rejections: [rejection], executions: [initialExecution("running")],
  });
  await expect(chips.nth(0)).toContainText("Started", { timeout: 15000 });
  await chips.nth(0).click();
  await expect(page.getByRole("dialog").getByRole("list", { name: "Invocation progress" }).locator("li", { hasText: "Runtime ready" })).toHaveAttribute("data-state", "done");
  await expect(page.getByRole("dialog").locator("li", { hasText: "Reasoning started" })).toHaveAttribute("data-state", "done");
  await page.screenshot({ path: "test-results/mention-invocation-working.png", fullPage: true });
  await page.keyboard.press("Escape");
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    error: "Channel not found",
  }, { status: 403 });
  // Without launch evidence a summon keeps the words as written and claims no status.
  await expect(page.locator(".app-mention-summon-written")).toHaveCount(3, { timeout: 15000 });
  await expect(chips.locator(".app-mention-invocation-status")).toHaveCount(0);
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [codex, claude], rejections: [rejection],
  });
  await page.clock.fastForward(11000);
  await expect(chips).toHaveCount(3, { timeout: 15000 });
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [{ ...codex, activity: { ...codex.activity, phase: "wrapper_startup_failed", runStatus: "exited" } }, claude], rejections: [rejection],
  });
  await expect(chips.nth(0)).toContainText("Failed", { timeout: 15000 });
  await expect(chips.nth(1)).toContainText("Started");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 360, height: 800 });
  await chips.nth(0).click();
  const popup = page.getByRole("dialog");
  await expect(popup).toBeVisible();
  // The portal can be visible before Floating UI applies collision positioning
  // after the viewport resize. Require the original bounds within a short budget.
  await expect(async () => {
    const bounds = await popup.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  }).toPass({ timeout: 5000 });
  await page.screenshot({ path: "test-results/mention-invocation-mobile.png", fullPage: true });
});

test("a started summon stays started whatever its Run does next", async ({ page }) => {
  const finished = { ...codex, activity: { ...codex.activity, phase: "turn_completed" } };
  await installInvocationFixture(page, [finished, claude]);
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", { launches: [finished, claude], executions: [initialExecution("completed")] });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const chip = page.locator(".app-mention-invocation").first();
  await expect(chip).toContainText("Started");
  await expect(chip).toHaveAttribute("data-tone", "success");
  await expect(chip.locator(".app-invocation-spinner")).toHaveCount(0);
  await chip.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Retry startup" })).toHaveCount(0);
  // Nothing about the reply or the Run's end: the summon's question is answered.
  await expect(dialog).not.toContainText("reply");
  await expect(dialog).not.toContainText("Unconfirmed");
  await page.screenshot({ path: "test-results/mention-invocation-execution-finished.png", fullPage: true });
  await page.keyboard.press("Escape");
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [{ ...finished, activity: { ...finished.activity, runStatus: "stopped", phase: "run_delivery_failed" } }, claude],
    rejections: [rejection], executions: [initialExecution("completed")],
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-mention-invocation").first()).toContainText("Started");
});

test("reborn and handoff phrases show their own successor without requiring current membership", async ({ page }) => {
  await installInvocationFixture(page, [], `${reborn.sourceMention} restart; ${handoff.sourceMention} continue.`, [reborn, handoff]);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  // A handoff draws both of its Agents as invocation chips joined by an arrow.
  const chips = page.locator(".app-mention-invocation");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText("Spawning");
  await expect(chips.nth(0)).not.toContainText("Starting");
  await expect(chips.nth(0).locator(".app-mention-chip-label")).toHaveText("@Alpha:1:reborn");
  const card = page.locator(".app-mention-handoff");
  const ends = card.locator(".app-mention-invocation");
  await expect(ends.nth(0).locator(".app-mention-chip-label")).toHaveText("@Beta:2");
  await expect(ends.nth(0)).toContainText("Handed off");
  await expect(ends.nth(0)).toHaveAttribute("data-tone", "neutral");
  await expect(ends.nth(1).locator(".app-mention-chip-label")).toHaveText("@Gamma");
  await expect(ends.nth(1)).toContainText("Took over");
  await expect(ends.nth(1)).toHaveAttribute("data-tone", "success");
  await expect(card.locator(".app-handoff-arrow")).toHaveAttribute("data-tone", "success");
  await card.click();
  await expect(page.getByRole("dialog")).toContainText("Handoff recorded");
  await expect(page.getByRole("dialog").getByRole("heading", { name: "@Beta → @Gamma", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Successor Run created");
  await expect(page.getByRole("dialog")).not.toContainText("Machine accepted");
  await expect(page.getByRole("dialog").locator("li", { hasText: "Reasoning started" })).toHaveAttribute("data-state", "done");
  await page.screenshot({ path: "test-results/mention-invocation-continuations.png", fullPage: true });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 360, height: 800 });
  await card.click();
  const bounds = await page.getByRole("dialog").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
  await page.screenshot({ path: "test-results/mention-invocation-continuations-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", { error: "Access revoked" }, { status: 403 });
  await expect(chips).toHaveCount(0, { timeout: 15000 });
});

const handoffPick = (mention: string, name: string) => ({
  ...launch(name, "registration"),
  sourceMention: mention,
  targetName: "auto",
  routingDecision: {
    source: "jev",
    evaluatedAt: E2E_NOW,
    rows: [],
    parameters: {
      rubricVersion: "registration-parameters-v7",
      evaluatedAt: E2E_NOW,
      inputDigest: "a".repeat(64),
      selections: { model: "grok-4", effort: "high", workspaceKind: "repo", repo: "LambdaLabsHQ/xmatrix" },
      choices: [
        { key: "modelEffort", selected: "model_1", probabilities: { model_0: 0.2, model_1: 0.8 } },
        { key: "workspace", selected: "workspace_0", probabilities: { workspace_0: 1 } },
        { key: "placement", selected: "placement_stationary", probabilities: { placement_any: 0.3, placement_stationary: 0.7 } },
      ],
      harness: { inputDigest: "a".repeat(64), selected: "grok", probabilities: { grok: 0.7, claude: 0.3 } },
    },
    machine: { id: "machine:abc", name: "Workstation" },
  },
});

test("an elsewhere handoff shows the parameters Jev picked on the successor chip", async ({ page }) => {
  const autoMention = "@claude:4:handoff:@auto";
  const namedMention = "@claude:4:handoff:@grok";
  await installInvocationFixture(page, [handoffPick(autoMention, "auto"), handoffPick(namedMention, "grok")],
    `${autoMention} continue; ${namedMention} too`);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const cards = page.locator(".app-mention-handoff");
  await expect(cards).toHaveCount(2);
  const auto = cards.nth(0);
  const named = cards.nth(1);
  // Opened from history: the picks are already lit, and the arrival does not replay.
  await expect(auto.locator('[data-jev="true"]')).toHaveText([
    "harness:grok", "model:grok-4", "effort:high", "repo:LambdaLabsHQ/xmatrix",
  ]);
  await expect(auto.locator('[data-routing="true"]')).toHaveText(["machine:Workstation"]);
  await expect(auto).not.toContainText("placement:");
  await expect(auto.locator('[data-jev-arriving="true"]')).toHaveCount(0);
  await expect(auto.locator(".app-mention-invocation").nth(1)).toContainText("Starting");
  await expect(auto.locator(".app-mention-invocation").nth(1)).not.toContainText("Picking");
  await expect(auto).toHaveAttribute("aria-label", /xMatrix filled harness:grok, model:grok-4, effort:high, repo:LambdaLabsHQ\/xmatrix\. Routing filled machine:Workstation/);
  // A successor the author named is already on the chip, so harness is not drawn again.
  await expect(named.locator('[data-jev="true"]')).toHaveText([
    "model:grok-4", "effort:high", "repo:LambdaLabsHQ/xmatrix",
  ]);
  await expect(named.locator('[data-routing="true"]')).toHaveText(["machine:Workstation"]);
  await expect(named.locator(".app-mention-chip-label").nth(1)).toContainText("@grok");
  await page.setViewportSize({ width: 360, height: 800 });
  for (const card of [auto, named]) {
    const box = await card.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    const tag = await card.locator('[data-jev="true"]').last().boundingBox();
    expect(tag!.x).toBeGreaterThanOrEqual(0);
    expect(tag!.x + tag!.width).toBeLessThanOrEqual(360);
  }
});

test("a fresh @auto handoff stays on Picking until the picked launch arrives", async ({ page }) => {
  const mention = "@claude:4:handoff:@auto";
  await page.clock.install({ time: new Date(E2E_NOW) });
  await installInvocationFixture(page, [], `${mention} continue`);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const card = page.locator(".app-mention-handoff");
  await expect(card.locator(".app-mention-invocation").nth(1)).toContainText("Picking");
  await expect(card.locator('[data-jev="true"]')).toHaveCount(0);
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [handoffPick(mention, "auto")], rejections: [], continuations: [],
  });
  await expect(card.locator('[data-jev="true"]')).toHaveText([
    "harness:grok", "model:grok-4", "effort:high", "repo:LambdaLabsHQ/xmatrix",
  ], { timeout: 10_000 });
  await expect(card.locator('[data-routing="true"]')).toHaveText(["machine:Workstation"]);
  await expect(card.locator(".app-mention-invocation").nth(1)).toContainText("Starting");
  await expect(card.locator(".app-mention-invocation").nth(1)).not.toContainText("Picking");
});

test("invalid workspace syntax remains on its own mention beside a valid call to the same Agent", async ({ page }) => {
  const invalidAddress = "＠codex pwd:workspace:missing";
  const valid = { ...codex, sourceMention: "@codex pwd:/tmp/project" };
  await installInvocationFixture(page, [valid], `${invalidAddress} inspect; ${valid.sourceMention} continue.`);
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [valid], rejections: [{ ...rejection, invocationId: "rejected:syntax", sourceMention: invalidAddress,
      targetRef: "codex", code: "workspace_syntax_invalid",
      message: "Use an absolute working directory or a repository reference. Quote paths that contain spaces." }],
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const chips = page.locator(".app-mention-invocation");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toContainText("Failed");
  await expect(chips.nth(1)).toContainText("Connecting");
  await expect(chips.nth(1)).not.toContainText("Starting");
  await expect(chips.nth(0)).toHaveAttribute("aria-label", /^@codex pwd:workspace:missing:/);
  await chips.nth(0).click();
  await expect(page.getByRole("dialog")).toContainText("Use an absolute working directory");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Retry startup" })).toHaveCount(0);
});

test("literal examples cannot inherit the status of the same address in an active heading", async ({ page }) => {
  const address = codex.sourceMention;
  const body = [
    `\`${address}\``, `> ${address}`, `[${address}](https://example.test)`, `~~${address}~~`,
    `\\${address} and &commat;${address.slice(1)}`, `# ${address}`,
  ].join("\n\n");
  await installInvocationFixture(page, [codex], body);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-mention-invocation")).toHaveCount(1);
  await expect(page.locator(".rich-message h1 .app-mention-invocation")).toContainText("Connecting");
  for (const selector of ["blockquote", "code", "a", "del"]) {
    await expect(page.locator(`.rich-message ${selector} .app-mention-invocation`)).toHaveCount(0);
  }
});

test("long plain-text rendering preserves literal command examples", async ({ page }) => {
  const address = codex.sourceMention;
  const body = `${address} inspect\n\n\`\`\`\n${address}\n\`\`\`\n\n${"context ".repeat(8000)}`;
  await installInvocationFixture(page, [codex], body);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.locator(".message-plain-text")).toBeVisible();
  await expect(page.locator(".app-mention-invocation")).toHaveCount(1);
  await expect(page.locator(".message-plain-text")).toContainText("```");
});

test("a quoted workspace remains one complete invocation address", async ({ page }) => {
  const address = '@codex pwd:"/tmp/repo.v2 with spaces"';
  await installInvocationFixture(page, [{ ...codex, sourceMention: address }], `${address} inspect`);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const chip = page.locator(".app-mention-invocation");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute("aria-label", `${address}: Connecting. Show invocation details`);
  await chip.click();
  await page.getByRole("dialog").getByText("Details", { exact: true }).click();
  await expect(page.getByRole("dialog").locator("code")).toContainText(address);
});


test("an existing-instance mention carries no status; status belongs to a startup", async ({ page }) => {
  await installInvocationFixture(page, [], "@Alpha:1 review; @Beta:2 test.");
  const target = (name: string, ordinal: number) => ({ id: `target-${ordinal}`, channelId: E2E_CHANNEL.id,
    sourceMessageId: messageId, sourceEntityVersion: 1, sourceBodyHash: "a".repeat(64), sourceMention: `@${name}:${ordinal}`,
    targetName: name, channelInstanceId: `${ordinal}`, resolution: "resolved",
    instanceId: `instance-${ordinal}`, runId: `run-${ordinal}`, runStatus: "running", createdAt: E2E_NOW });
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [], targets: [target("Alpha", 1), target("Beta", 2)], executions: [], nextCursor: null,
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".rich-message")).toContainText("@Alpha:1 review");
  await expect(page.locator(".app-mention-invocation")).toHaveCount(0);
});

test("typed startup failures explain their stage and clear after confirmed recovery", async ({ page }) => {
  await page.clock.install({ time: new Date(E2E_NOW) });
  const failure = { code: "postgres_runtime_unavailable", stage: "relay.authenticate", originStage: "authority.request",
    diagnosticId: "diag_11111111-1111-4111-8111-111111111111", retryable: true };
  const retrying = { ...codex, activity: { ...codex.activity, operationFailure: failure,
    errorCode: failure.code, diagnosticId: failure.diagnosticId } };
  await installInvocationFixture(page, [retrying], `${codex.sourceMention} inspect`);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const chip = page.locator(".app-mention-invocation");
  await expect(chip).toContainText("Connecting");
  await expect(chip).not.toContainText("Starting");
  await chip.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Checking credentials: The runtime service is temporarily unavailable.");
  await expect(dialog).toContainText("Origin: Authority request");
  await expect(dialog).toContainText(failure.diagnosticId);
  await page.setViewportSize({ width: 393, height: 852 });
  await page.clock.runFor(100);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(393);
  await page.screenshot({ path: "test-results/mention-typed-startup-failure-mobile.png", fullPage: true });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(393);
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [{ ...codex, activity: { runStatus: "running", phase: "runtime_ready", updatedAt: E2E_NOW,
      wrapperReadyAt: E2E_NOW } }], nextCursor: null,
  });
  await page.clock.fastForward(3000);
  await expect(chip).toContainText("Initializing");
  await expect(chip).not.toContainText("Starting");
  await expect(dialog).not.toContainText("Checking credentials");
  await expect(dialog).not.toContainText(failure.diagnosticId);
});

test("inline recovery selects a saved reply and checks its receipt without rerunning the input", async ({ page }) => {
  await page.clock.install({ time: new Date(E2E_NOW) });
  const finished = { ...codex, activity: { ...codex.activity, phase: "turn_completed" } };
  await installInvocationFixture(page, [finished, claude]);
  await page.setViewportSize({ width: 393, height: 852 });
  const execution = { ...initialExecution("completed"), recoveryAvailable: true };
  const queryPattern = "**/api/xmatrix/channels/channel-general/agent-launches/query";
  const recoveryPattern = "**/executions/initial-execution/recover-reply**";
  await fixtureJson(page, "invocation-launches", queryPattern, { launches: [finished, claude], executions: [execution] });
  await fixtureJson(page, "recovery-post", recoveryPattern, { status: "completed", result: { status: "selection_required", candidates: [
    { messageId: "saved-one", createdAt: 1782864000 }, { messageId: "saved-two", createdAt: 1782864060 },
  ] } }, { method: "POST", echoRequestId: true });
  await fixtureJson(page, "unexpected-task-post", "**/api/xmatrix/channels/channel-general/messages", {}, { method: "POST" });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const chip = page.locator(".app-mention-invocation").first(); await chip.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Recover saved reply", exact: true }).click();
  await expect(dialog).toContainText("Choose the saved reply");
  await dialog.getByRole("button", { name: /Reply from/ }).nth(1).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/mention-reply-recovery-mobile.png", fullPage: true });
  await fixtureJson(page, "recovery-post", recoveryPattern, { status: "queued" }, { method: "POST", echoRequestId: true });
  await fixtureJson(page, "recovery-get", recoveryPattern, { status: "completed", result: { status: "committed", messageId: "saved-two" } }, { method: "GET", echoRequestId: true });
  await dialog.getByRole("button", { name: /Reply from/ }).nth(1).click();
  await page.clock.fastForward(1600);
  await expect.poll(async () => (await fixtureRequests(page, "recovery-get")).length).toBe(1);
  await expect(dialog).toContainText("Publication confirmed");
  await fixtureJson(page, "invocation-launches", queryPattern, { launches: [finished, claude],
    executions: [{ ...execution, finalReply: { messageId: "saved-two", committedAt: E2E_NOW } }] });
  await page.clock.fastForward(2200);
  await expect(chip).toContainText("Started");
  const posts = await fixtureRequestBodies(page, "recovery-post");
  expect(posts).toHaveLength(2); expect(Object.keys(posts[0])).toEqual(["requestId"]);
  expect(posts[1].messageId).toBe("saved-two"); expect(posts[1].requestId).not.toBe(posts[0].requestId);
  expect(await fixtureRequests(page, "recovery-get")).toHaveLength(1);
  expect(await fixtureRequests(page, "unexpected-task-post")).toHaveLength(0);
});

/* The chip is an inline-flex box inside running prose, so its own baseline is
   what the sentence around it aligns against. Centring the flex line takes that
   baseline off the label's text and onto the avatar, which lifts the whole pill
   off the line — so measure the two text runs, not the pill's box. */
test("the invocation chip sits on the baseline of the prose around it", async ({ page }) => {
  // A summon stacks its status under the expression; the inline chip is a
  // continuation's (reborn or handoff), which runs inside the sentence.
  await installInvocationFixture(page, [],
    `${reborn.sourceMention} windows 你来 and more words; ${handoff.sourceMention} tail words follow it.`, [reborn, handoff]);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-mention-invocation")).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
  const offsets = await page.evaluate(() => {
    // A text run's client rect is its font box, so two runs of one size share a
    // top only when they share a baseline.
    const runRect = (node: Node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect(); };
    const firstText = (root: Node) => {
      // A walker never yields its own root, so a bare text node answers itself.
      if (root.nodeType === Node.TEXT_NODE) return root.nodeValue?.trim() ? root : null;
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walk.nextNode();
      while (node && !node.nodeValue?.trim()) node = walk.nextNode();
      return node;
    };
    // A handoff card runs inside the sentence as one unit, led by its source chip.
    return [...document.querySelectorAll(".rich-message .app-mention-handoff, " +
      ".rich-message .app-mention-invocation:not(.app-mention-handoff .app-mention-invocation)")].map((chip) => {
      const label = firstText(chip.querySelector(".app-mention-chip-label")!)!;
      // The prose continuing the sentence starts on the chip's own line.
      let prose: ChildNode | null = chip.nextSibling;
      while (prose && !firstText(prose)) prose = prose.nextSibling;
      const name = chip.textContent?.slice(0, 12);
      if (!prose) return { name, offset: "no prose followed this chip" };
      return { name, offset: Number((runRect(label).top - runRect(firstText(prose)!).top).toFixed(2)) };
    });
  });
  expect(offsets).toHaveLength(2);
  for (const measured of offsets) expect(measured).toMatchObject({ offset: 0 });
});

/* The visible circle is the face inside the avatar, and it sits in a pill, so
   it is centred on the pill: a circle on the text's x-height midline rode
   ~1.4px low in its pill. Check both faces the component can render — a
   picture and the initial fallback used to disagree by 3.8px because each
   synthesized the avatar's baseline differently; the face is now out of flow,
   so neither can move it. */
test("the invocation chip's avatar is centred in its pill, picture or initial", async ({ page }) => {
  await installInvocationFixture(page, [],
    `${reborn.sourceMention} restart; ${handoff.sourceMention} continue.`, [reborn, handoff]);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-mention-invocation")).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
  const offsets = (usePicture: boolean) => page.evaluate((picture) => {
    return [...document.querySelectorAll(".rich-message .app-mention-invocation")].map((chip) => {
      const face = chip.querySelector(".app-mention-chip-avatar-face") as HTMLElement;
      if (picture) {
        const img = document.createElement("img");
        // A 1x1 transparent GIF: the component's own <img> geometry, no network.
        img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        face.replaceChildren(img);
      }
      const pill = chip.getClientRects()[0]!;
      const box = face.getBoundingClientRect();
      return { name: chip.textContent?.slice(0, 10), offset: Math.round(Math.abs(box.top + box.height / 2 - (pill.top + pill.height / 2)) * 2) / 2,
        inside: box.top >= pill.top && box.bottom <= pill.bottom };
    });
  }, usePicture);
  for (const measured of await offsets(false)) expect(measured).toMatchObject({ offset: 0, inside: true });
  for (const measured of await offsets(true)) expect(measured).toMatchObject({ offset: 0, inside: true });
});


test("tagged preflight rejection shows candidate evidence without a fabricated launch", async ({ page }) => {
  const expression = '@auto repo:LambdaLabsHQ/xmatrix machine:missing';
  const body = `Please inspect: ${expression} look at this`;
  await installInvocationFixture(page, [], body);
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [], rejections: [{ ...rejection, sourceMention: expression, targetRef: 'auto', code: 'routing_no_eligible',
      message: 'No eligible environment matched this summon. No launch was allocated.', routingDecision: {
        source: 'deterministic', candidateCount: 2, evaluatedAt: E2E_NOW,
        rows: ['profile-a', 'profile-b'].map(profileId => ({ profileId, harness: 'codex', machineId: 'same-machine',
          selected: false, activeRuns: 1, maxConcurrent: 1, excluded: ['machine_mismatch'],
          quotaObservation: { status: 'stale', source: 'provider', observedAt: E2E_NOW, expiresAt: E2E_NOW } })) } }],
  });
  await page.goto('/app/personal-sspaceperso/channels/general-cchannelgen', { waitUntil: 'domcontentloaded' });
  const chip = page.locator('.rich-message .app-mention-invocation');
  await expect(chip).toHaveCount(1);
  await expect(chip.locator('.app-mention-chip-label')).toHaveText(expression);
  await expect(chip).toContainText('Failed');
  await chip.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Rejected before launch allocation');
  await expect(dialog).toContainText('No eligible environment matched this summon.');
  await expect(dialog.getByText('Candidate observations')).toBeVisible();
  await expect(dialog.locator('.app-routing-row')).toHaveCount(0);
  await expect(dialog).not.toContainText('profile-a');
  await expect(dialog).not.toContainText('profile-b');
  await expect(dialog.getByText('Observed facts')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/preflight-rejection-evidence.png', fullPage: true });
});

test("the summon chip lists every checked environment, including Grok past the old cutoff", async ({ page }) => {
  const excluded = Array.from({ length: 9 }, (_, index) => ({
    harness: index === 8 ? "grok" : "claude",
    machineId: `machine-${index}`,
    label: index === 8 ? "grok-air" : `claude-${index}`,
    machineLabel: `host-${index}`,
    activeRuns: 1,
    maxConcurrent: 1,
    selected: false,
    excluded: ["machine_unreachable"],
  }));
  const mention = "@auto repo:LambdaLabsHQ/xmatrix";
  const auto = {
    ...launch("auto", "agent_mention_spawn"),
    sourceMention: mention,
    targetName: "bobos",
    routingDecision: {
      source: "jev",
      parameters: { rubricVersion: "launch-parameters-v3", evaluatedAt: E2E_NOW, inputDigest: "a".repeat(64),
        environment: { inputDigest: "b".repeat(64), selected: "candidate_1", probabilities: { candidate_0: .2, candidate_1: .8 } },
        selections: { model: "model-B", effort: "high", workspaceKind: "repo", repo: "LambdaLabsHQ/xmatrix" },
        choices: [{ key: "modelEffort", selected: "model_1", probabilities: { model_0: .1, model_1: .9 } },
          { key: "workspace", selected: "workspace_0", probabilities: { workspace_0: 1 } }] },
      rows: [
        { harness: "codex", machineId: "machine-bobos", label: "bobos", machineLabel: "星豆号",
          remainingQuota: 8, activeRuns: 0, maxConcurrent: 1, selected: true },
        ...excluded,
      ],
    },
  };
  await installInvocationFixture(page, [auto], `${mention} explain this decision`);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const chip = page.locator(".app-mention-invocation").first();
  // The chip carries Jev's choices as tags; the machine it measured is in the panel only.
  await expect(chip).not.toContainText("xMatrix chose");
  // Jev's model and effort land in the mention. The repository was already
  // written, so it is not filled a second time, and a decision opened from
  // history does not replay the arrival animation.
  const filled = chip.locator('[data-jev="true"]');
  await expect(filled).toHaveText(["model:model-B", "effort:high"]);
  await expect(chip.locator('[data-routing="true"]')).toHaveText(["machine:星豆号"]);
  await expect(chip.locator('[data-jev-arriving="true"]')).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-label", /xMatrix filled model:model-B, effort:high\. Routing filled machine:星豆号/);
  await chip.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("li", { hasText: "Environment selected" })).toContainText("bobos · Codex · 星豆号 · 8% left · repo LambdaLabsHQ/xmatrix");
  await dialog.getByText("Details", { exact: true }).click();
  await expect(dialog).toContainText("Quota unknown");
  await expect(dialog.getByRole("list", { name: "Not eligible" })).toContainText("grok-air");
  await expect(dialog.getByRole("list", { name: "Not eligible" })).toContainText("claude-0");
  await expect(dialog.locator(".app-routing-row")).toHaveCount(10);
  await dialog.getByText("Launch parameter decisions").click();
  await expect(dialog).toContainText("Model: model-B · Effort: high");
  await expect(dialog).toContainText("Workspace: repo · LambdaLabsHQ/xmatrix");
  await expect(dialog).not.toContainText(/oneshot/i);
  await expect(dialog).toContainText("model_1: 90.0%");
  await expect(dialog).toContainText("Environment: candidate_1");
  await expect(dialog).toContainText("candidate_1: 80.0%");
  await expect(dialog).toContainText("Environment input digest: " + "b".repeat(64));
  await page.setViewportSize({ width: 393, height: 852 });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(393);
});

test("a refusal notice hides environments outside explicit constraints", async ({ page }) => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    harness: index === 9 ? "grok" : "codex",
    machineId: `machine-${index}`,
    label: index === 9 ? "grok-air" : `codex-${index}`,
    machineLabel: `host-${index}`,
    activeRuns: 1,
    maxConcurrent: 1,
    selected: false,
    excluded: index === 9 ? ["machine_unreachable"] : ["machine_mismatch"],
  }));
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [{ ...E2E_CHANNEL, messageCount: 1, historyHeadSequence: 1 }] });
  await fixtureJson(page, "routing-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [{
      messageId: "notice-routing", channelId: E2E_CHANNEL.id, sequence: 1,
      body: "No eligible environment matched this summon. No Agent was started.\n\ncodex-0 · Codex · host-0: at capacity",
      sentAt: E2E_NOW,
      from: { kind: "user", label: "xMatrix", userId: "system", email: "system@xmatrix.test" },
      metadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
        routingDecision: { source: "deterministic", rows } },
    }],
    hasMore: false,
  });
  await fixtureJson(page, "routing-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [], rejections: [], continuations: [], nextCursor: null,
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-routing-row")).toHaveCount(1);
  await expect(page.getByText("codex-0", { exact: true })).toHaveCount(0);
  await expect(page.getByText("grok-air")).toBeVisible();
  await expect(page.locator(".app-message-timeline").getByText("No eligible environment matched this summon. No Agent was started.")).toBeVisible();
  await expect(page.locator(".app-message-timeline").getByText("codex-0 · Codex · host-0: at capacity")).toHaveCount(0);
});

for (const denied of [false, true]) test(`the panel ${denied ? 'says Jev decisions are private' : "shows what Jev read and answered"}`, async ({ page }) => {
  await installInvocationFixture(page, [codex]);
  const pattern = '**/api/xmatrix/channels/channel-general/messages/message-invocations/decision-evidence**';
  await fixtureJson(page, 'decision-records', pattern, denied ? { error: 'not found' } : { records: [
    { refId: 'decision:one:started', createdAt: E2E_NOW, encodedBytes: 900 },
    { refId: 'decision:one:succeeded', createdAt: E2E_NOW, encodedBytes: 300 },
  ], nextCursor: null, retentionDays: 30 }, { status: denied ? 404 : 200 });
  if (!denied) {
    await fixtureJson(page, 'decision-input', `${pattern}?refId=decision%3Aone%3Astarted`, {
      version: 1, decisionId: 'one', status: 'started', at: E2E_NOW, invocationId: messageId,
      input: { state: { message: source, channelContext: { hierarchy: [{ name: 'general' }],
        messages: [{ sentAt: E2E_NOW, body: 'CI is red on main' }], historyTruncated: false } },
      questions: { modelEffort: { type: 'choice', instructions: 'Select a supported model and effort pair.', criteria: {
        model_0: JSON.stringify({ model: 'gpt-5.5', description: 'Frontier model', effort: 'high' }),
        model_1: JSON.stringify({ model: '', default: true }),
      } } } },
    });
    await fixtureJson(page, 'decision-answer', `${pattern}?refId=decision%3Aone%3Asucceeded`, {
      version: 1, decisionId: 'one', status: 'succeeded', at: E2E_NOW, invocationId: messageId,
      answers: { modelEffort: { choice: 'model_0', probabilities: { model_0: .82, model_1: .18 } } },
    });
  }
  await page.goto('/app/personal-sspaceperso/channels/general-cchannelgen', { waitUntil: 'domcontentloaded' });
  await page.locator('.app-mention-invocation').first().click();
  const dialog = page.getByRole('dialog');
  if (denied) {
    await dialog.getByText('Details', { exact: true }).click();
    await expect(dialog).toContainText("Routing decisions are visible only to the summoning user.");
    return;
  }
  // Jev's answers come first, one row each, then the startup measured after them.
  const jev = dialog.getByRole('region', { name: "Routing decision" });
  const answer = jev.getByRole('listitem').filter({ hasText: 'Model' }).first();
  await expect(answer).toContainText('gpt-5.5 · high');
  await expect(answer).toContainText('82%');
  await expect(jev.getByText('Select a supported model and effort pair.')).toBeHidden();
  await answer.getByText('gpt-5.5 · high').first().click();
  await expect(answer.getByText('Select a supported model and effort pair.')).toBeVisible();
  await expect(answer.locator('li[data-selected]')).toContainText('gpt-5.5 · high');
  await expect(answer.locator('li:not([data-selected])', { hasText: 'Harness default' })).toContainText('18%');
  await jev.getByText('Input', { exact: true }).click();
  await expect(jev).toContainText(source);
  await expect(jev).toContainText('1 earlier message in #general');
  await expect(jev).toContainText('CI is red on main');
  await expect(dialog.getByRole('list', { name: 'Invocation progress' })).not.toContainText('Read as a request');
  await dialog.getByText('Details', { exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'input' })).toHaveAttribute('href', /refId=decision%3Aone%3Astarted/);
});

test('a historical parameter failure shows its retained cause before raw records', async ({ page }) => {
  const mention = '@auto repo:LambdaLabsHQ/xmatrix';
  await installInvocationFixture(page, [], `${mention} fix tests`);
  await fixtureJson(page, 'parameter-rejection', '**/api/xmatrix/channels/channel-general/agent-launches/query', {
    launches: [], rejections: [{ ...rejection, invocationId: `routing-preflight:${messageId}:0`,
      sourceMention: mention, targetRef: 'auto', code: 'routing_parameter_selection_failed',
      message: 'Launch parameter selection failed. No launch was allocated.',
      routingDecision: { source: 'jev', rows: [{ harness: 'claude', machineId: 'machine-1',
        label: 'claude', machineLabel: 'Legend Mac', activeRuns: 3, selected: true }] } }],
  });
  const pattern = '**/api/xmatrix/channels/channel-general/messages/message-invocations/decision-evidence**';
  await fixtureJson(page, 'historical-decision-list', pattern, { records: [
    { refId: 'decision:one:failed', createdAt: E2E_NOW, encodedBytes: 120 },
    { refId: 'decision:later:failed', createdAt: new Date(Date.parse(E2E_NOW) + 10_000).toISOString(), encodedBytes: 120 },
  ], nextCursor: null, retentionDays: 30 });
  await fixtureJson(page, 'historical-failure-detail', `${pattern}?refId=decision%3Aone%3Afailed`, {
    status: 'failed', invocationId: `auto:${messageId}:0`, reason: 'invalid_answer', code: 'invalid_answer',
    answerFailure: { questionKey: 'workspace', issue: 'choice_not_offered' },
  });
  await fixtureJson(page, 'later-failure-detail', `${pattern}?refId=decision%3Alater%3Afailed`, {
    status: 'failed', invocationId: `auto:${messageId}:0`, reason: 'provider_error', code: 'jev_rate_limited',
  });
  await page.goto('/app/personal-sspaceperso/channels/general-cchannelgen', { waitUntil: 'domcontentloaded' });
  await page.locator('.app-mention-invocation').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Cause: Jev\'s "workspace" answer selected an option that was not offered.');
  await expect(dialog).toContainText('Selected environment: claude · Claude Code · Legend Mac');
  await expect(dialog).not.toContainText('Process startup is confirmed separately');
  await expect(dialog.getByText('Candidate observations')).toBeVisible();
  await expect(dialog.getByText('Observed facts')).not.toBeVisible();
});

/* The reported incident: Jev chose an environment the visible rows no longer
   show, the Agent replied, then its Run was stopped. The panel read "Stopped",
   "No Agent was started. 0 environments were checked." above a process that
   had started and replied. */
test("a started summon never claims no Agent was started", async ({ page }) => {
  const mention = "@claude repo:LambdaLabsHQ/xmatrix";
  const stopped = { ...launch("claude", "agent_mention_spawn"), sourceMention: mention, firstReplyAt: E2E_NOW,
    activity: { runStatus: "stopped", updatedAt: E2E_NOW, hostName: "build01", startupSteps: [{ phase: "cwd_ready", at: E2E_NOW }] },
    routingDecision: { source: "jev", evaluatedAt: E2E_NOW, rows: [{ harness: "claude", machineId: "machine-other",
      activeRuns: 0, selected: false, excluded: ["machine_mismatch"] }] } };
  await installInvocationFixture(page, [stopped], `${mention} look`);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const chip = page.locator(".app-mention-invocation");
  await expect(chip).toContainText("Started");
  await chip.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Details", { exact: true }).click();
  await expect(dialog).not.toContainText("No Agent was started");
  await expect(dialog).not.toContainText("environments were checked");
  await expect(dialog).not.toContainText("Stopped");
  await expect(dialog).not.toContainText("Unconfirmed");
  for (const label of ["Machine accepted", "Process started", "Joined channel", "Runtime ready"]) {
    await expect(dialog.getByRole("list", { name: "Invocation progress" }).locator("li", { hasText: label })).toHaveAttribute("data-state", "done");
  }
  await page.screenshot({ path: "test-results/mention-invocation-started-incident.png" });
});

const stopReceipt = (phase: "accepted" | "confirmed") => ({
  stopId: `message-invocations:run-claude`, channelId: E2E_CHANNEL.id, sourceMessageId: messageId,
  runId: "run-claude", targetName: "claude", instanceOrdinal: "1", machineName: "build-box-1",
  phase, requestedAt: E2E_NOW, ...(phase === "confirmed" ? { confirmedAt: E2E_NOW } : {}),
});

/** One stop command on the channel, with the receipt query this test names. */
async function openStopChip(page: Page, body: string, stops: unknown[], fixtureName: string) {
  await installInvocationFixture(page, [], body);
  await fixtureJson(page, fixtureName, "**/api/xmatrix/channels/channel-general/agent-launches/query", {
    launches: [], stops,
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  return page.locator(".app-mention-invocation");
}

test("a confirmed stop sits on the command instead of another message", async ({ page }) => {
  const chip = await openStopChip(page, "@claude:1:stop", [stopReceipt("confirmed")], "stop-receipts");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("@claude:1:stop");
  await expect(chip).toContainText("Stopped");
  await expect(chip).toHaveAttribute("data-tone", "success");
  await expect(page.getByText("xMatrix is reading")).toHaveCount(0);
  await expect(page.getByText("Stop requested for")).toHaveCount(0);
  await chip.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("The Workstation confirmed the process tree is terminated.");
  await expect(dialog).toContainText("build-box-1");
  await expect(dialog).toContainText("Stopped");
  await page.screenshot({ path: "test-results/mention-stop-confirmed-desktop.png" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 360, height: 800 });
  await chip.click();
  await expect(dialog).toBeVisible();
  await expect(async () => {
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  }).toPass({ timeout: 5000 });
  await page.screenshot({ path: "test-results/mention-stop-confirmed-mobile.png" });
});

test("a stop's reason stays prose beside the command chip", async ({ page }) => {
  const chip = await openStopChip(page, "@claude:1:stop two agents took the same work", [stopReceipt("confirmed")], "stop-receipts-reason");
  await expect(chip).toContainText("Stopped");
  await expect(chip).toContainText("@claude:1:stop");
  await expect(chip).not.toContainText("two agents took the same work");
  await expect(chip.locator("xpath=..")).toContainText("two agents took the same work");
  await page.screenshot({ path: "test-results/mention-stop-reason.png" });
});

test("an accepted stop says Stopping until the Workstation confirms it", async ({ page }) => {
  const chip = await openStopChip(page, "@claude:1:stop", [stopReceipt("accepted")], "stop-receipts-accepted");
  await expect(chip).toContainText("Stopping");
  await expect(chip.locator(".app-invocation-spinner")).toBeVisible();
  await expect(page.getByText("xMatrix is reading")).toHaveCount(0);
  await chip.click();
  await expect(page.getByRole("dialog")).toContainText("Waiting for the Workstation to confirm the process has terminated.");
});

/* After "Jev is reading", the parameters Jev chose enter the mention one per
   beat, in the order it chose them. One not yet revealed is not drawn at all,
   so the chip grows with each instead of holding empty space. */
test("Jev's choices enter the mention one by one, taking no space before they arrive", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 2_000) });
  const mention = "@auto";
  const auto = { ...launch("auto", "agent_mention_spawn"), sourceMention: mention, targetName: "bobos",
    routingDecision: { source: "jev", parameters: { rubricVersion: "registration-parameters-v7", evaluatedAt: E2E_NOW, inputDigest: "a".repeat(64),
      harness: { inputDigest: "b".repeat(64), selected: "codex", probabilities: { codex: .77, claude: .23 } },
      selections: { model: "gpt-5.5", effort: "high", workspaceKind: "repo", repo: "LambdaLabsHQ/xmatrix" },
      choices: [{ key: "modelEffort", selected: "model_0", probabilities: { model_0: .68, model_1: .32 } },
        { key: "workspace", selected: "workspace_0", probabilities: { workspace_0: 1 } }] },
      rows: [{ harness: "codex", machineId: "machine-bobos", label: "bobos", machineLabel: "build01", activeRuns: 0, selected: true }] } };
  await installInvocationFixture(page, [], `${mention} fix the flaky registration tests`);
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query",
    { launches: [], rejections: [], continuations: [] });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-mention-summon-written")).toContainText("xMatrix is reading");
  await page.clock.pauseAt(new Date(Date.parse(E2E_NOW) + 20_000));
  await fixtureJson(page, "invocation-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query",
    { launches: [auto], rejections: [], continuations: [] });
  const chip = page.locator(".app-mention-invocation").first();
  const filled = chip.locator('[data-jev="true"]');
  // Step the clock in small slices until the decision lands, so the reveal's own beats stay ahead.
  for (let step = 0; step < 300 && await filled.count() === 0; step++) await page.clock.runFor(50);
  await expect(filled).toHaveText(["harness:codex"]);
  const first = (await chip.boundingBox())!.width;
  await page.clock.runFor(260);
  await expect(filled).toHaveText(["harness:codex", "model:gpt-5.5"]);
  expect((await chip.boundingBox())!.width).toBeGreaterThan(first);
  await page.clock.runFor(520);
  await expect(filled).toHaveText(["harness:codex", "model:gpt-5.5", "effort:high", "repo:LambdaLabsHQ/xmatrix"]);
  // Routing binds the Machine after Jev has chosen, so its tag enters last.
  await expect(chip.locator('[data-routing="true"]')).toHaveCount(0);
  await page.clock.runFor(260);
  await expect(chip.locator('[data-routing="true"]')).toHaveText("machine:build01");
  await page.clock.runFor(800);
  await expect(chip.locator('[data-jev-arriving="true"]')).toHaveCount(0);
  await expect(filled).toHaveCount(4);
  // After the parameters the chip says what is happening now, in its -ing word;
  // not the name of a step, nor which machine was chosen.
  const status = chip.locator(".app-mention-invocation-status");
  await expect(status).toHaveText(/Connecting$/);
  await expect(status).not.toContainText("Joined channel");
  await expect(chip).not.toContainText("xMatrix chose");
});
