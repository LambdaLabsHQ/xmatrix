import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_SPACE, fixtureJson, fixtureRequestBodies, fixtureRule, openWorkspaceWithStubs } from "./workspace-fixtures";
import { expectDraft, setDraftSelection } from "./composer-draft";

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
test.beforeEach(async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL],
    registrations: [{ key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "mac-id", harness: "codex" },
      displayName: "codex", machineName: "My Mac", models: ["test-model"],
      modelCatalog: [{ model: "test-model", efforts: [{ value: "high" }] }] }],
    launchTargets: { repos: [{ value: "owner/xmatrix" }], workspaces: [
      { canonicalCwd: "/work/xmatrix", ownerUserId: "e2e-user", machineId: "mac-id", hostName: "My Mac" }
    ] },
  });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
});

async function selectRepository(page: import("@playwright/test").Page) {
  const input = page.locator(".composer-textarea").first();
  await input.fill("@auto repo:xmat");
  await expect(page.locator(".app-mention-suggestions")).toContainText("owner/xmatrix");
  await input.press("Tab");
  return input;
}

test("a fresh @ offers runtimes only, and conditions after the summon", async ({ page }) => {
  const input = page.locator(".composer-textarea").first();
  const overlay = page.locator(".app-mention-suggestions");
  await input.fill("@");
  await expect(overlay.getByRole("option").filter({ hasText: "codex" }).first()).toBeVisible();
  await expect(overlay.getByText("Agent", { exact: true })).toBeVisible();
  await expect(overlay.getByText("Condition", { exact: true })).toHaveCount(0);
  for (const condition of ["repo:owner/xmatrix", "model:test-model", "machine:"]) {
    await expect(overlay.getByRole("option").filter({ hasText: condition })).toHaveCount(0);
  }
  await input.fill("@xmat");
  await expect(overlay.getByRole("option").filter({ hasText: "owner/xmatrix" })).toHaveCount(0);
  await input.fill("@codex ");
  await expect(overlay.getByRole("option").filter({ hasText: "repo:owner/xmatrix" })).toBeVisible();
  await expect(overlay.getByRole("option").filter({ hasText: "model:test-model" })).toBeVisible();
});

test("a set condition leaves no options of its field in the completion", async ({ page }) => {
  await fixtureJson(page, "two-repos", "**/api/xmatrix/spaces/*/launch-targets**", {
    spaceId: E2E_SPACE.id, repoStatus: "authorized",
    repos: [{ value: "owner/one" }, { value: "owner/two" }], workspaces: [],
  });
  await page.reload();
  const input = page.locator(".composer-textarea").first();
  const overlay = page.locator(".app-mention-suggestions");
  await input.fill("@auto repo:own");
  await overlay.getByRole("option").filter({ hasText: "repo:owner/one" }).click();
  await expectDraft(input, "@auto repo:owner/one ");
  // The chosen repo is set, so no repo option remains; the other condition
  // fields are still offered.
  await expect(overlay.getByRole("option").filter({ hasText: "repo:" })).toHaveCount(0);
  await expect(overlay.getByRole("option").filter({ hasText: "model:test-model" })).toBeVisible();
});

test("completion stays in the message and highlights without a condition header", async ({ page }) => {
  const input = await selectRepository(page);
  await expectDraft(input, "@auto repo:owner/xmatrix ");
  await expect(page.getByLabel("Task launch conditions")).toHaveCount(0);
  await expect(input.locator(".app-mention-chip[data-mention]").first()).toHaveText("@auto repo:owner/xmatrix");
  await input.pressSequentially("model:tes");
  await input.press("Tab");
  await expectDraft(input, "@auto repo:owner/xmatrix model:test-model ");
  await input.press("Escape");
  await input.pressSequentially("ordinary words");
  await expectDraft(input, "@auto repo:owner/xmatrix model:test-model ordinary words");
});

test("a summon in the draft is drawn as its chip and wraps with the text, which stays as written", async ({ page }, testInfo) => {
  // A narrower window keeps the first summon wider than the composer, so it wraps.
  await page.setViewportSize({ width: 860, height: 900 });
  const input = page.locator(".composer-textarea").first();
  const body = "@auto repo:owner/xmatrix model:test-model effort:high\n@codex repo:owner/xmatrix";
  await input.fill(body);
  await input.press("Escape");
  await expectDraft(input, body);
  const chips = input.locator(".app-mention-chip[data-mention]");
  await expect(chips.filter({ hasText: "@auto repo:owner/xmatrix model:test-model effort:high" })).toHaveCount(1);
  // The harness summon leads with that harness's face, inside the same pill.
  await expect(input.locator(".app-composer-chip-lead .app-mention-chip-avatar-face")).toHaveCount(1);
  await expect(chips.filter({ hasText: "@codex repo:owner/xmatrix" })).toHaveCount(1);
  // Each wrapped line of the summon carries its own piece of the pill.
  const lines = await chips.first().evaluate(node => new Set([...node.getClientRects()].map(rect => Math.round(rect.top))).size);
  expect(lines).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: testInfo.outputPath("inline-composer.png") });
});

test("harness-first completion uses new syntax and preserves words before and after it", async ({ page }) => {
  const input = page.locator(".composer-textarea").first();
  await input.fill("Before @codex after");
  await setDraftSelection(input, 13);
  await input.press("ArrowLeft");
  await input.press("ArrowRight");
  await page.getByRole("option").filter({ hasText: "@codex" }).click();
  await expectDraft(input, "Before @codex after");
});

test("completing a later summon preserves the first summon, spacing, quotes and suffix", async ({ page }) => {
  const input = page.locator(".composer-textarea").first();
  const prefix = '  @auto effort:high repo:"owner/xmatrix" first\nthen @auto  ';
  await input.fill(prefix + "repo:own-old after  ");
  await setDraftSelection(input, "-old");
  await input.press("ArrowLeft");
  await input.press("ArrowRight");
  await expect(page.getByRole("option").filter({ hasText: "repo:owner/xmatrix" })).toBeVisible();
  await input.press("Tab");
  await expectDraft(input, prefix + "repo:owner/xmatrix after  ");
});

test("selecting Auto beside a summon adds another summon", async ({ page }) => {
  const input = page.locator(".composer-textarea").first();
  await input.fill("@auto @auto");
  await input.press("Tab");
  await expectDraft(input, "@auto @auto ");
});

for (const [name, body] of [
  ["ordinary prose", "  Any words\nremain exactly as written  "],
  ["summon without task", "@auto repo:owner/xmatrix"],
  ["multiple summons", '@auto effort:high repo:"owner/xmatrix"  first\n@auto second'],
  ["malformed syntax", "  @auto effort:high effort:low  "],
  ["retired syntax", "@codex:new: Check tests"],
]) {
  test(`sending ${name} preserves the original message`, async ({ page }) => {
    await fixtureJson(page, "source", "**/api/xmatrix/channels/channel-general/messages",
      { message: { id: "source-id" } }, { method: "POST" });
    const input = page.locator(".composer-textarea").first();
    await input.fill(body);
    await input.press("Escape");
    await input.press("Enter");
    await expect.poll(async () => (await fixtureRequestBodies(page, "source")).length).toBe(1);
    expect((await fixtureRequestBodies(page, "source"))[0].body).toBe(body);
  });
}

test("retired launch input has no workspace picker", async ({ page }) => {
  const input = page.locator(".composer-textarea").first();
  for (const body of ["@codex:new:", "@codex:once:", "@auto mode:once"]) {
    await input.fill(body);
    await expect(page.locator(".app-mention-suggestions")).not.toBeVisible();
    await expectDraft(input, body);
  }
});

test.describe("mobile launch syntax", () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  test("touch completion remains editable inline", async ({ page }) => {
    const input = page.locator(".composer-textarea").first();
    await input.fill("@codex");
    await page.getByRole("option").filter({ hasText: "@codex" }).tap();
    await expectDraft(input, "@codex ");
    await input.pressSequentially("effort:h");
    // TEMP diagnostics
    await page.waitForTimeout(500);
    console.log("DIAG", JSON.stringify(await input.evaluate((node) => {
      const field = (node as HTMLElement & { composerField?: { value: string; selectionStart: number } }).composerField;
      return { value: field?.value, at: field?.selectionStart, focused: document.activeElement === node, html: node.innerHTML,
        options: [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent) };
    })));
    await page.getByRole("option").filter({ hasText: "effort:high" }).tap();
    await expectDraft(input, "@codex effort:high ");
    await expect(page.getByLabel("Task launch conditions")).toHaveCount(0);
  });
});


test("new syntax completes from registrations without legacy Profiles or live instances", async ({ page }) => {
  // Override only this catalog. Reinstalling the entire workspace on a live
  // page temporarily lets the broad Space rule answer a pending page-tree read.
  await fixtureRule(page, { id: "launch-targets", pattern: "**/api/xmatrix/spaces/*/launch-targets**",
    responder: { kind: "launchTargets", repos: [{ value: "owner/registered-repo" }], workspaces: [
      { canonicalCwd: "/work/registered", ownerUserId: "e2e-user", machineId: "registered-machine", hostName: "registered-host" }] } });
  const registration = {
    key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "registered-machine", harness: "codex" },
    displayName: "Codex", ownerName: "Owner", machineName: "Registered Mac", version: 1,
    state: "enabled", routingReady: true, models: ["registered-model"],
    modelCatalog: [{ model: "registered-model", description: "", efforts: [{ value: "high", description: "" }] }],
    canManageOwnerGrant: false, canConfigureSpace: false, canRemoveFromSpace: false,
  };
  await fixtureJson(page, "registration-catalog", "**/api/xmatrix/spaces/*/agent-registrations", {
    registrations: [registration], capabilities: [{ harness: "codex", models: registration.models, locations: [registration] }],
  });
  await page.reload();
  const input = page.locator(".composer-textarea").first();
  // Start directly at a field; no preceding @ completion should be needed to load the catalogs.
  for (const [fragment, suggestion, result] of [
    ["repo:registered", "repo:owner/registered-repo", "repo:owner/registered-repo"],
    ["machine:registered", "machine:Registered Mac", 'machine:"Registered Mac"'],
    ["harness:cod", "@codex", "@codex"],
    ["model:registered", "model:registered-model", "model:registered-model"],
    ["effort:hi", "effort:high", "effort:high"],
    ["pwd:/work", "pwd:/work/registered", 'pwd:/work/registered machine:"Registered Mac"'],
  ]) {
    await input.fill("Before @auto " + fragment);
    await page.getByRole("option").filter({ hasText: suggestion }).click();
    await expectDraft(input, "Before " + (result.startsWith("@") ? result : "@auto " + result) + " ");
    await input.press("Escape");
  }
  await expect(page.getByLabel("Task launch conditions")).toHaveCount(0);
});


test("typing a summon and a space opens tag choices without changing Enter submission", async ({ page }) => {
  await fixtureJson(page, "source", "**/api/xmatrix/channels/channel-general/messages",
    { message: { id: "source-id" } }, { method: "POST" });
  const input = page.locator(".composer-textarea").first();
  await input.fill("@auto ");
  await expect(page.getByRole("option").filter({ hasText: "repo:owner/xmatrix" })).toBeVisible();
  await input.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(page, "source")).length).toBe(1);
  expect((await fixtureRequestBodies(page, "source"))[0].body).toBe("@auto ");
});


test("machine values stay visible while typing the colon and value", async ({ page }) => {
  const input = page.locator(".composer-textarea").first();
  const machine = page.getByRole("option").filter({ hasText: "machine:My Mac" });
  await input.fill("@codex machine");
  await expect(machine).toBeVisible();
  await input.pressSequentially(":");
  await expect(machine).toBeVisible();
  await expect(page.getByRole("option").filter({ hasText: "pwd:" })).toHaveCount(0);
  await input.pressSequentially("My");
  await expect(machine).toBeVisible();
  await input.press("Tab");
  await expectDraft(input, '@codex machine:"My Mac" ');
  await input.pressSequentially("model:tes");
  await input.press("Tab");
  await expectDraft(input, '@codex machine:"My Mac" model:test-model ');
});
