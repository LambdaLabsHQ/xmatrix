import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_SPACE, fixtureJson, fixtureRequestBodies, installWorkspaceStubs, openWorkspaceWithStubs } from "./workspace-fixtures";

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
  const input = page.locator("textarea.composer-textarea").first();
  await input.fill("@auto repo:xmat");
  await expect(page.locator(".app-mention-suggestions")).toContainText("owner/xmatrix");
  await input.press("Tab");
  return input;
}

test("a fresh @ offers runtimes only, and conditions after the summon", async ({ page }) => {
  const input = page.locator("textarea.composer-textarea").first();
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
  const input = page.locator("textarea.composer-textarea").first();
  const overlay = page.locator(".app-mention-suggestions");
  await input.fill("@auto repo:own");
  await overlay.getByRole("option").filter({ hasText: "repo:owner/one" }).click();
  await expect(input).toHaveValue("@auto repo:owner/one ");
  // The chosen repo is set, so no repo option remains; the other condition
  // fields are still offered.
  await expect(overlay.getByRole("option").filter({ hasText: "repo:" })).toHaveCount(0);
  await expect(overlay.getByRole("option").filter({ hasText: "model:test-model" })).toBeVisible();
});

test("completion stays in the message and highlights without a condition header", async ({ page }) => {
  const input = await selectRepository(page);
  await expect(input).toHaveValue("@auto repo:owner/xmatrix ");
  await expect(page.getByLabel("Task launch conditions")).toHaveCount(0);
  await expect(page.getByTestId("composer-text-highlight").first()).toContainText("@auto repo:owner/xmatrix");
  await input.pressSequentially("model:tes");
  await input.press("Tab");
  await expect(input).toHaveValue("@auto repo:owner/xmatrix model:test-model ");
  await input.press("Escape");
  await input.pressSequentially("ordinary words");
  await expect(input).toHaveValue("@auto repo:owner/xmatrix model:test-model ordinary words");
});

test("inline highlight follows textarea wrapping and scrolling without editing the message", async ({ page }, testInfo) => {
  const input = page.locator("textarea.composer-textarea").first();
  const body = Array.from({ length: 15 }, (_, index) => `line ${index} @auto repo:owner/xmatrix ordinary words`).join("\n");
  await input.fill(body);
  await input.press("Escape");
  await input.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll")); });
  const mirror = page.getByTestId("composer-text-highlight").first();
  // Compare longhands: the computed `font` shorthand is "" on both sides, so it
  // once matched while the mirror drew 16px marks under 14px text.
  const typography = (node: Element) => {
    const style = getComputedStyle(node);
    return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing];
  };
  const geometry = await input.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollTop, scrollHeight: node.scrollHeight }));
  await expect.poll(() => mirror.evaluate(node => node.scrollTop)).toBe(geometry.scroll);
  expect(await mirror.evaluate(node => node.clientWidth)).toBe(geometry.width);
  expect(await mirror.evaluate(typography)).toEqual(await input.evaluate(typography));
  // Same wrapping: the mirror's text is exactly as tall as the textarea's
  // (the mirror carries one trailing newline so a final empty line still counts).
  expect(Math.abs(await mirror.evaluate(node => node.scrollHeight) - geometry.scrollHeight))
    .toBeLessThanOrEqual(await input.evaluate(node => parseFloat(getComputedStyle(node).lineHeight)));
  await expect(input).toHaveValue(body);
  await page.screenshot({ path: testInfo.outputPath("inline-composer.png") });
});

test("a summon is one band per line, over its words, clear of the next line", async ({ page }) => {
  // A narrower window keeps the first summon wider than the composer, so it wraps.
  await page.setViewportSize({ width: 860, height: 900 });
  const input = page.locator("textarea.composer-textarea").first();
  await input.fill("@auto repo:owner/xmatrix model:test-model effort:high\n@codex repo:owner/xmatrix");
  await input.press("Escape");
  const mirror = page.getByTestId("composer-text-highlight").first();
  await expect(mirror.locator(".app-composer-mention-band").first()).toBeAttached();
  const { bands, lines } = await mirror.evaluate(node => {
    const bands = [...node.querySelectorAll<HTMLElement>(".app-composer-mention-band")]
      .map(band => ({ key: band.dataset.key ?? "", ...band.getBoundingClientRect().toJSON() }));
    // Where each mention's text landed, one box per word per line.
    const lines = [...node.querySelectorAll("[data-mention]")].flatMap((span, mention) => {
      const text = span.firstChild as Text;
      return [...(text.data.matchAll(/\S+/gu))].flatMap(word => {
        const range = document.createRange();
        range.setStart(text, word.index!);
        range.setEnd(text, word.index! + word[0].length);
        return [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => ({ mention, ...rect.toJSON() }));
      });
    });
    return { bands, lines };
  });
  expect(new Set(lines.map(line => Math.round(line.top))).size).toBeGreaterThanOrEqual(3);
  const middle = (rect: { top: number; bottom: number }) => (rect.top + rect.bottom) / 2;
  const sameLine = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) => Math.abs(middle(a) - middle(b)) < 6;
  const lineOf = (rect: { top: number; bottom: number }) => Math.round(middle(rect) / 19);
  // Every word sits inside a band on its own line, and no mention has two bands on one line.
  for (const word of lines) {
    const band = bands.find(candidate => sameLine(candidate, word) && candidate.left <= word.left && candidate.right >= word.right);
    expect(band, `a band under word at ${word.left},${word.top}`).toBeTruthy();
  }
  const perLine = new Map<string, number>();
  for (const band of bands) {
    const key = `${band.key.split("\u0000")[0]}@${lineOf(band)}`;
    perLine.set(key, (perLine.get(key) ?? 0) + 1);
  }
  expect([...perLine.values()].every(count => count === 1)).toBe(true);
  // Bands on consecutive lines never touch.
  const sorted = [...bands].sort((a, b) => a.top - b.top);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index]!.top - sorted[index - 1]!.top < 4) continue;
    expect(sorted[index]!.top - sorted[index - 1]!.bottom).toBeGreaterThanOrEqual(2);
  }
});

test("harness-first completion uses new syntax and preserves words before and after it", async ({ page }) => {
  const input = page.locator("textarea.composer-textarea").first();
  await input.fill("Before @codex after");
  await input.evaluate(node => node.setSelectionRange(13, 13));
  await input.press("ArrowLeft");
  await input.press("ArrowRight");
  await page.getByRole("option").filter({ hasText: "@codex" }).click();
  await expect(input).toHaveValue("Before @codex after");
});

test("completing a later summon preserves the first summon, spacing, quotes and suffix", async ({ page }) => {
  const input = page.locator("textarea.composer-textarea").first();
  const prefix = '  @auto effort:high repo:"owner/xmatrix" first\nthen @auto  ';
  await input.fill(prefix + "repo:own-old after  ");
  await input.evaluate(node => node.setSelectionRange(node.value.indexOf("-old"), node.value.indexOf("-old")));
  await input.press("ArrowLeft");
  await input.press("ArrowRight");
  await expect(page.getByRole("option").filter({ hasText: "repo:owner/xmatrix" })).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue(prefix + "repo:owner/xmatrix after  ");
});

test("selecting Auto beside a summon adds another summon", async ({ page }) => {
  const input = page.locator("textarea.composer-textarea").first();
  await input.fill("@auto @auto");
  await input.press("Tab");
  await expect(input).toHaveValue("@auto @auto ");
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
    const input = page.locator("textarea.composer-textarea").first();
    await input.fill(body);
    await input.press("Escape");
    await input.press("Enter");
    await expect.poll(async () => (await fixtureRequestBodies(page, "source")).length).toBe(1);
    expect((await fixtureRequestBodies(page, "source"))[0].body).toBe(body);
  });
}

test("retired launch input has no workspace picker", async ({ page }) => {
  const input = page.locator("textarea.composer-textarea").first();
  for (const body of ["@codex:new:", "@codex:once:", "@auto mode:once"]) {
    await input.fill(body);
    await expect(page.locator(".app-mention-suggestions")).not.toBeVisible();
    await expect(input).toHaveValue(body);
  }
});

test.describe("mobile launch syntax", () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  test("touch completion remains editable inline", async ({ page }) => {
    const input = page.locator("textarea.composer-textarea").first();
    await input.fill("@codex");
    await page.getByRole("option").filter({ hasText: "@codex" }).tap();
    await expect(input).toHaveValue("@codex ");
    await input.pressSequentially("effort:h");
    await page.getByRole("option").filter({ hasText: "effort:high" }).tap();
    await expect(input).toHaveValue("@codex effort:high ");
    await expect(page.getByLabel("Task launch conditions")).toHaveCount(0);
  });
});


test("new syntax completes from registrations without legacy Profiles or live instances", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL],
    launchTargets: { repos: [{ value: "owner/registered-repo" }], workspaces: [
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
  const input = page.locator("textarea.composer-textarea").first();
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
    await expect(input).toHaveValue("Before " + (result.startsWith("@") ? result : "@auto " + result) + " ");
    await input.press("Escape");
  }
  await expect(page.getByLabel("Task launch conditions")).toHaveCount(0);
});


test("typing a summon and a space opens tag choices without changing Enter submission", async ({ page }) => {
  await fixtureJson(page, "source", "**/api/xmatrix/channels/channel-general/messages",
    { message: { id: "source-id" } }, { method: "POST" });
  const input = page.locator("textarea.composer-textarea").first();
  await input.fill("@auto ");
  await expect(page.getByRole("option").filter({ hasText: "repo:owner/xmatrix" })).toBeVisible();
  await input.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(page, "source")).length).toBe(1);
  expect((await fixtureRequestBodies(page, "source"))[0].body).toBe("@auto ");
});


test("machine values stay visible while typing the colon and value", async ({ page }) => {
  const input = page.locator("textarea.composer-textarea").first();
  const machine = page.getByRole("option").filter({ hasText: "machine:My Mac" });
  await input.fill("@codex machine");
  await expect(machine).toBeVisible();
  await input.pressSequentially(":");
  await expect(machine).toBeVisible();
  await expect(page.getByRole("option").filter({ hasText: "pwd:" })).toHaveCount(0);
  await input.pressSequentially("My");
  await expect(machine).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue('@codex machine:"My Mac" ');
  await input.pressSequentially("model:tes");
  await input.press("Tab");
  await expect(input).toHaveValue('@codex machine:"My Mac" model:test-model ');
});
