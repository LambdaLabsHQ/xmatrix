import { expect, test } from "./fixtures";
import {
  E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, fixtureRequestBodies, fixtureRequests, fixtureRule, installWorkspaceStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const INTENT = "0123456789abcdef0123456789abcdef";
const base = { intentId: INTENT, spaceId: E2E_SPACE.id, expiresAt: "2099-01-01T00:00:00.000Z", registeredHarnesses: [] };
const terminal = { userCode: "WDJB-MJHT", hostname: "daniel-laptop", platform: "linux-x64" };

type Rule = Parameters<typeof fixtureRule>[1];

async function openWithIntent(page: import("@playwright/test").Page, state: Record<string, unknown>, rules: Rule[] = [],
  path = "/app") {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
  await fixtureRule(page, { id: "intent-create", pattern: "**/api/xmatrix/setup-intents",
    responder: { kind: "static", json: { ...base, phase: "waiting" } } });
  await fixtureRule(page, { id: "intent-read", pattern: `**/api/xmatrix/setup-intents/${INTENT}`,
    responder: { kind: "static", json: state } });
  for (const rule of rules) await fixtureRule(page, rule);
  await fixtureRule(page, { id: "funnel", pattern: "**/api/xmatrix/observable/onboarding-step", method: "POST",
    responder: { kind: "static", status: 202, json: {} } });
  await page.goto(path, { waitUntil: "domcontentloaded" });
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

test.describe("on a phone", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("the command's link is emailed to the person's own computer, three a day", async ({ page }) => {
    const connect = await openWithIntent(page, { ...base, phase: "waiting" }, [{
      id: "intent-email", pattern: `**/api/xmatrix/setup-intents/${INTENT}/email`, method: "POST",
      responder: { kind: "static", status: 429,
        json: { error: "You've sent this link 3 times today. Try again tomorrow.", code: "setup_link_email_limited" } } }]);
    const send = connect.getByRole("button", { name: "Send to my computer" });
    await send.click();
    // The day's limit says so, rather than "busy, try again".
    await expect(connect.getByRole("alert")).toHaveText("You've sent this link 3 times today. Try again tomorrow.");
    await fixtureRule(page, { id: "intent-email", pattern: `**/api/xmatrix/setup-intents/${INTENT}/email`, method: "POST",
      responder: { kind: "static", json: {} } });
    await send.click();
    await expect(connect).toContainText("Sent to your email. Open it on your computer to continue there.");
    // The email is written in the page's language; nothing else rides along.
    const bodies = await fixtureRequestBodies(page, "intent-email");
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).toEqual({ locale: "en" });
    await expect.poll(async () => (await counted(page)).filter((event) => event.step === "link_emailed"))
      .toEqual([{ step: "link_emailed", surface: "space", device: "phone" }]);
  });
});

test("the emailed link opens the same setup on the computer", async ({ page }) => {
  // A fresh command would carry another id; the link's own must be the one shown.
  const connect = await openWithIntent(page, { ...base, phase: "waiting" }, [{ id: "intent-create",
    pattern: "**/api/xmatrix/setup-intents", responder: { kind: "static", json: { ...base, intentId: "f".repeat(32), phase: "waiting" } } }],
  `/connect/computer?intent=${INTENT}`);
  await expect(page).toHaveURL(new RegExp(`/app/${E2E_SPACE.id}`, "u"));
  await expect(connect).toContainText(`bash -s -- --connect ${INTENT}`);
  expect(await fixtureRequests(page, "intent-create")).toHaveLength(0);
});
