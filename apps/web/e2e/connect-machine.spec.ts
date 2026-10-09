import { expect, test } from "./fixtures";
import {
  E2E_DESKTOP_CONTEXT, E2E_SPACE, fixtureRequestBodies, fixtureRequests, fixtureRule, installWorkspaceStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const INTENT = "0123456789abcdef0123456789abcdef";
const base = { intentId: INTENT, spaceId: E2E_SPACE.id, expiresAt: "2099-01-01T00:00:00.000Z", registeredHarnesses: [] };
const terminal = { userCode: "WDJB-MJHT", hostname: "daniel-laptop", platform: "linux-x64" };

type Rule = Parameters<typeof fixtureRule>[1];

async function openWithIntent(page: import("@playwright/test").Page, state: Record<string, unknown>, rules: Rule[] = []) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
  for (const rule of rules) await fixtureRule(page, rule);
  await fixtureRule(page, { id: "intent-create", pattern: "**/api/xmatrix/setup-intents",
    responder: { kind: "static", json: { ...base, phase: "waiting" } } });
  await fixtureRule(page, { id: "intent-read", pattern: `**/api/xmatrix/setup-intents/${INTENT}`,
    responder: { kind: "static", json: state } });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  return page.getByTestId("connect-machine");
}

test("the Space's empty screen shows a setup command that carries only its id", async ({ page }) => {
  const connect = await openWithIntent(page, { ...base, phase: "waiting" });
  await expect(connect).toContainText(`bash -s -- --connect ${INTENT}`);
  await expect(connect).toContainText("Waiting for the command…");
  await connect.getByRole("button", { name: "On Windows?" }).click();
  await expect(connect).toContainText(`$env:XMATRIX_CONNECT='${INTENT}'`);
});

test("a waiting terminal is approved with the code it shows", async ({ page }) => {
  const connect = await openWithIntent(page, { ...base, phase: "approval", terminal }, [{
    id: "intent-approve", pattern: `**/api/xmatrix/setup-intents/${INTENT}/approve`,
    responder: { kind: "static", json: { ok: true } } }]);
  await expect(connect).toContainText("daniel-laptop wants to connect with code WDJB-MJHT");
  await connect.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(() => fixtureRequestBodies(page, "intent-approve")).toEqual([{ userCode: "WDJB-MJHT" }]);
});

test("a connected machine hands its agents to the installed-harness switches", async ({ page }) => {
  const connect = await openWithIntent(page, {
    ...base, phase: "connected", terminal,
    machine: { machineId: "machine-1", name: "daniel-laptop", online: true,
      harnesses: [{ id: "claude", installed: true }, { id: "codex", installed: true }, { id: "gemini", installed: false }] },
  });
  await expect(connect).toContainText("daniel-laptop is connected. Found Claude Code and Codex.");
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
