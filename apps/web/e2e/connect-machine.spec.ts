import { expect, test } from "./fixtures";
import {
  E2E_DESKTOP_CONTEXT, E2E_SPACE, fixtureRequestBodies, fixtureRule, installWorkspaceStubs,
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

test("the agents found on the connected machine come in with one click", async ({ page }) => {
  const connect = await openWithIntent(page, {
    ...base, phase: "connected", terminal,
    machine: { machineId: "machine-1", name: "daniel-laptop", online: true,
      harnesses: [{ id: "claude", installed: true }, { id: "codex", installed: true }, { id: "gemini", installed: false }] },
  }, [{ id: "registration-create", pattern: `**/api/xmatrix/spaces/${E2E_SPACE.id}/agent-registrations/commands`,
    responder: { kind: "static", json: { ok: true } } }]);
  await expect(connect).toContainText("daniel-laptop is connected. Found Claude Code and Codex.");
  await connect.getByRole("button", { name: "Bring them in" }).click();
  await expect.poll(async () => (await fixtureRequestBodies(page, "registration-create"))
    .map((body) => (body.key as { harness: string; machineId: string }))).toEqual([
    expect.objectContaining({ harness: "claude", machineId: "machine-1", spaceId: E2E_SPACE.id }),
    expect.objectContaining({ harness: "codex", machineId: "machine-1", spaceId: E2E_SPACE.id }),
  ]);
});
