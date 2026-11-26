import { expect, test } from "./fixtures";
import {
  E2E_DESKTOP_CONTEXT, E2E_SPACE, fixtureJson, fixtureRequestBodies, fixtureRequests, fixtureRule, installWorkspaceStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const INTENT = "0123456789abcdef0123456789abcdef";
const base = { intentId: INTENT, spaceId: E2E_SPACE.id, expiresAt: "2099-01-01T00:00:00.000Z", registeredHarnesses: [] };
const terminal = { userCode: "WDJB-MJHT", hostname: "daniel-laptop", platform: "linux-x64" };

type Rule = Parameters<typeof fixtureRule>[1];

async function openWithIntent(page: import("@playwright/test").Page, state: Record<string, unknown>, rules: Rule[] = []) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
  // An explicit opt-in on the account, answered by the Hub.
  await fixtureJson(page, "diagnostics-consent", /\/me\/diagnostics(?:\?|$)/u,
    { accountRegime: "consent-required", requestRegime: "consent-required", choice: "opted-in" }, { method: "GET" });
  await fixtureRule(page, { id: "intent-create", pattern: "**/api/xmatrix/setup-intents",
    responder: { kind: "static", json: { ...base, phase: "waiting" } } });
  await fixtureRule(page, { id: "intent-read", pattern: `**/api/xmatrix/setup-intents/${INTENT}`,
    responder: { kind: "static", json: state } });
  for (const rule of rules) await fixtureRule(page, rule);
  await fixtureRule(page, { id: "funnel", pattern: "**/api/xmatrix/observable/onboarding-step", method: "POST",
    responder: { kind: "static", status: 202, json: {} } });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  return page.getByTestId("connect-machine");
}

/** The steps counted so far, as the Hub received them. */
const counted = (page: import("@playwright/test").Page) => fixtureRequestBodies(page, "funnel");

test("the Space's empty screen shows a setup command that carries only its id", async ({ page }) => {
  const connect = await openWithIntent(page, { ...base, phase: "waiting" });
  await expect(connect).toContainText(`bash -s -- --connect ${INTENT}`);
  await expect(connect).toContainText("Waiting for your computer…");
  // Seeing and copying the command are counted once each, with where and on what.
  const copy = connect.getByRole("button", { name: /^(Copy|Copied)$/u });
  await copy.click();
  await copy.click();
  await expect.poll(() => counted(page)).toEqual([
    { step: "command_shown", surface: "space", device: "desktop_web" },
    { step: "command_copied", surface: "space", device: "desktop_web" },
  ]);
  await connect.getByRole("button", { name: "Windows?" }).click();
  await expect(connect).toContainText(`$env:XMATRIX_CONNECT='${INTENT}'`);
});

test("a waiting terminal is approved with the code it shows", async ({ page }) => {
  const connect = await openWithIntent(page, { ...base, phase: "approval", terminal }, [{
    id: "intent-approve", pattern: `**/api/xmatrix/setup-intents/${INTENT}/approve`,
    responder: { kind: "static", json: { ok: true } } }]);
  await expect(connect).toContainText("daniel-laptop wants to connect with code");
  await expect(connect).toContainText("WDJB-MJHT");
  await connect.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(() => fixtureRequestBodies(page, "intent-approve")).toEqual([{ userCode: "WDJB-MJHT" }]);
  // The command was on screen until the terminal's request arrived.
  await expect.poll(() => counted(page)).toEqual([
    { step: "command_shown", surface: "space", device: "desktop_web" },
    { step: "terminal_seen", surface: "space", device: "desktop_web" },
    { step: "approved", surface: "space", device: "desktop_web" },
  ]);
});

test("a connected machine hands its agents to the installed-harness switches", async ({ page }) => {
  const connect = await openWithIntent(page, {
    ...base, phase: "connected", terminal,
    machine: { machineId: "machine-1", name: "daniel-laptop", online: true,
      harnesses: [{ id: "claude", installed: true }, { id: "codex", installed: true }, { id: "gemini", installed: false }] },
  });
  await expect(connect).toContainText("Found Claude Code and Codex.");
  // The switches read the same machine report, so the page reads it again now.
  await expect.poll(async () => (await fixtureRequests(page, "machine-daemons")).length).toBeGreaterThanOrEqual(2);
});

test("a stranger's terminal is turned away without approving it", async ({ page }) => {
  const connect = await openWithIntent(page, { ...base, phase: "approval", terminal }, [{
    id: "intent-decline", pattern: `**/api/xmatrix/setup-intents/${INTENT}/decline`,
    responder: { kind: "static", json: { ok: true } } }]);
  await connect.getByRole("button", { name: "Not mine" }).click();
  await expect.poll(async () => (await fixtureRequests(page, "intent-decline")).length).toBe(1);
});

test("a failed command preparation can be retried without reloading the Space", async ({ page }) => {
  const connect = await openWithIntent(page, { ...base, phase: "waiting" }, [{
    id: "intent-create", pattern: "**/api/xmatrix/setup-intents",
    responder: { kind: "static", status: 503, json: { error: "Temporarily unavailable" } },
  }]);
  await expect(connect.getByRole("alert")).toBeVisible();
  await fixtureRule(page, { id: "intent-create", pattern: "**/api/xmatrix/setup-intents",
    responder: { kind: "static", json: { ...base, phase: "waiting" } } });
  await connect.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(connect).toContainText(`bash -s -- --connect ${INTENT}`);
  await expect(connect).toContainText("Waiting for your computer…");
  await expect(connect.getByRole("alert")).toHaveCount(0);
});

test("a failed connection read hides stale approval and can recover without approving", async ({ page }) => {
  const connect = await openWithIntent(page, { ...base, phase: "approval", terminal }, [{
    id: "intent-approve", pattern: `**/api/xmatrix/setup-intents/${INTENT}/approve`,
    responder: { kind: "static", json: { ok: true } },
  }]);
  await expect(connect.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  const preparations = await fixtureRequests(page, "intent-create");
  await fixtureRule(page, { id: "intent-read", pattern: `**/api/xmatrix/setup-intents/${INTENT}`,
    responder: { kind: "static", status: 503, json: { error: "Temporarily unavailable" } } });
  await expect(connect.getByRole("alert")).toBeVisible({ timeout: 20_000 });
  await expect(connect.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await fixtureRule(page, { id: "intent-read", pattern: `**/api/xmatrix/setup-intents/${INTENT}`,
    responder: { kind: "static", json: { ...base, phase: "approval", terminal } } });
  await connect.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(connect.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(connect.getByRole("alert")).toHaveCount(0);
  expect(await fixtureRequests(page, "intent-approve")).toHaveLength(0);
  expect(await fixtureRequests(page, "intent-create")).toEqual(preparations);
});

test("a connected machine with no agent offers the installer of whichever agent is chosen", async ({ page }) => {
  const connect = await openWithIntent(page, {
    ...base, phase: "connected", terminal: { ...terminal, platform: "windows-x86_64" },
    machine: { machineId: "machine-1", name: "daniel-laptop", online: true, harnesses: [{ id: "claude", installed: false }] },
  });
  await expect(connect).toContainText("daniel-laptop has no agent yet. Install one there and it shows up here:");
  const picker = connect.getByTestId("agent-install-picker");
  // The terminal said it is Windows, so it is shown Windows installers.
  await expect(picker).toContainText("irm 'https://claude.ai/install.ps1' | iex");
  await picker.getByRole("combobox", { name: "Agent to install" }).click();
  await picker.getByRole("option", { name: "Qwen Code" }).click();
  await expect(picker).toContainText("npm install -g @qwen-code/qwen-code@latest");
});

test("an expired setup command stops polling until the user asks for a fresh one", async ({ page }) => {
  const connect = await openWithIntent(page, { ...base, phase: "waiting" });
  await expect(connect).toContainText(`bash -s -- --connect ${INTENT}`);
  const initialCreates = (await fixtureRequests(page, "intent-create")).length;
  expect(initialCreates).toBe(1);

  await fixtureRule(page, { id: "intent-read", pattern: `**/api/xmatrix/setup-intents/${INTENT}`,
    responder: { kind: "static", status: 404, json: { error: "Setup request not found", code: "setup_intent_not_found" } } });
  await expect(connect.getByRole("alert")).toContainText("This setup command expired.", { timeout: 20_000 });
  await expect(connect).not.toContainText("Waiting for your computer…");
  // Must not auto-create a fresh intent loop in an unattended tab.
  expect((await fixtureRequests(page, "intent-create")).length).toBe(initialCreates);

  const SECOND = "fedcba9876543210fedcba9876543210";
  await fixtureRule(page, { id: "intent-create", pattern: "**/api/xmatrix/setup-intents",
    responder: { kind: "static", json: { ...base, intentId: SECOND, phase: "waiting" } } });
  await fixtureRule(page, { id: "intent-read-second", pattern: `**/api/xmatrix/setup-intents/${SECOND}`,
    responder: { kind: "static", json: { ...base, intentId: SECOND, phase: "waiting" } } });
  await connect.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(connect).toContainText(`bash -s -- --connect ${SECOND}`);
  await expect(connect).toContainText("Waiting for your computer…");
  await expect(connect.getByRole("alert")).toHaveCount(0);
});

test.describe("macOS desktop browser", () => {
  test.use({
    ...E2E_DESKTOP_CONTEXT,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });

  test("app-first setup does not create or poll a setup intent until the terminal path is chosen", async ({ page }) => {
    const connect = await openWithIntent(page, { ...base, phase: "waiting" });
    await expect(connect).toContainText("Get the xMatrix app on this computer");
    expect(await fixtureRequests(page, "intent-create")).toHaveLength(0);
    expect(await fixtureRequests(page, "intent-read")).toHaveLength(0);

    await connect.getByRole("button", { name: "Use a terminal instead" }).click();
    await expect(connect).toContainText(`bash -s -- --connect ${INTENT}`);
    await expect.poll(async () => (await fixtureRequests(page, "intent-create")).length).toBe(1);
  });
});
