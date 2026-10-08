import { expect, test } from "./fixtures";
import {
  E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, fixtureJson, fixtureRequestBodies, fixtureRequests, fixtureRule, installWorkspaceStubs,
} from "./workspace-fixtures";

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
  await page.goto(`/app/${E2E_SPACE.id}/chat`, { waitUntil: "domcontentloaded" });
  return page.getByTestId("connect-machine").filter({ visible: true });
}

for (const viewport of [
  { name: "desktop", ...E2E_DESKTOP_CONTEXT },
  { name: "mobile", ...E2E_MOBILE_CONTEXT },
]) {
  test.describe(viewport.name, () => {
    test.use(viewport);

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
      });
      await expect(connect).toContainText("daniel-laptop is connected. Found Claude Code and Codex.");
      await fixtureJson(page, "registration-create", "**/api/xmatrix/spaces/*/agent-registrations/commands", { version: 1 },
        { method: "POST" });
      // The Space's switches read the agent list back after each one comes in.
      const registration = (harness: string) => ({ key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user",
        machineId: "machine-1", harness }, displayName: harness, machineName: "daniel-laptop", ownerName: "E2E",
        state: "enabled", version: 1, models: [], routingReady: true, canManageOwnerGrant: true });
      await fixtureRule(page, { id: "catalog-after", pattern: /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?[^#]*)?$/u,
        responder: { kind: "sequence", responses: [["claude"], ["claude", "codex"]].map((harnesses) =>
          ({ json: { registrations: harnesses.map(registration), capabilities: [] } })) } });
      await connect.getByRole("button", { name: "Bring them in" }).click();
      await expect.poll(async () => (await fixtureRequestBodies(page, "registration-create"))
        .map((body) => (body.key as { harness: string; machineId: string }))).toEqual([
        expect.objectContaining({ harness: "claude", machineId: "machine-1", spaceId: E2E_SPACE.id }),
        expect.objectContaining({ harness: "codex", machineId: "machine-1", spaceId: E2E_SPACE.id }),
      ]);
    });

    test("Machines connects another machine with the same live command", async ({ page }) => {
      await openWithIntent(page, { ...base, phase: "waiting" });
      await fixtureJson(page, "connected-machine", /\/api\/xmatrix\/machine-daemons(?:\?.*)?$/u, { daemons: [{
        id: "daemon-1", userId: "e2e-user", machineId: "machine-1", name: "Laptop", machineName: "Laptop",
        status: "online", metadata: {}, connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      }] });
      await page.goto(`/app/${E2E_SPACE.id}/machines`, { waitUntil: "domcontentloaded" });
      const machines = page.getByRole("region", { name: "Machines", exact: true });
      await machines.getByRole("button", { name: "Connect a machine" }).click();
      await expect(machines.getByTestId("connect-machine")).toContainText(`--connect ${INTENT}`);
      if (viewport.isMobile) {
        await machines.getByRole("button", { name: "Machines", exact: true }).click();
        await expect(machines.getByRole("button", { name: "Connect a machine", exact: true })).toBeVisible();
      }
    });

    test("a failed command preparation can be retried", async ({ page }) => {
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
      await fixtureRule(page, { id: "intent-create-retry", pattern: "**/api/xmatrix/setup-intents", method: "POST",
        responder: { kind: "static", status: 403, json: { error: "Space access changed" } } });
      await fixtureJson(page, "intent-read", `**/api/xmatrix/setup-intents/${INTENT}`, { ...base, phase: "waiting" });
      await page.goto(`/app/${E2E_SPACE.id}/chat`);
      const connect = page.getByTestId("connect-machine").filter({ visible: true });
      await expect(connect.getByRole("alert")).toHaveText("Space access changed");
      await fixtureJson(page, "intent-create-success", "**/api/xmatrix/setup-intents", { ...base, phase: "waiting" });
      await connect.getByRole("button", { name: "Try again" }).click();
      await expect(connect).toContainText(`--connect ${INTENT}`);
      await expect(connect.getByRole("alert")).toHaveCount(0);
    });

    test("reload resumes the command and an expired command is replaced", async ({ page }) => {
      const connect = await openWithIntent(page, { ...base, phase: "waiting" });
      await expect(connect).toContainText(`--connect ${INTENT}`);
      const creates = (await fixtureRequestBodies(page, "intent-create")).length;
      await page.reload();
      await expect(connect).toContainText(`--connect ${INTENT}`);
      expect(await fixtureRequestBodies(page, "intent-create")).toHaveLength(creates);
      const next = "abcdef0123456789abcdef0123456789";
      await fixtureJson(page, "intent-create-new", "**/api/xmatrix/setup-intents", { ...base, intentId: next, phase: "waiting" });
      await fixtureRule(page, { id: "intent-expired", pattern: `**/api/xmatrix/setup-intents/${INTENT}`,
        responder: { kind: "static", status: 404, json: { error: "Setup command expired" } } });
      await fixtureJson(page, "intent-new", `**/api/xmatrix/setup-intents/${next}`, { ...base, intentId: next, phase: "waiting" });
      await expect(connect).toContainText(`--connect ${next}`);
    });

    test("declining another terminal grants nothing and returns to waiting", async ({ page }) => {
      const connect = await openWithIntent(page, { ...base, phase: "approval", terminal }, [{
        id: "intent-decline", pattern: `**/api/xmatrix/setup-intents/${INTENT}/decline`,
        responder: { kind: "static", json: { ok: true } },
      }]);
      await expect(connect).toContainText(terminal.userCode);
      await fixtureJson(page, "after-decline", `**/api/xmatrix/setup-intents/${INTENT}`, { ...base, phase: "waiting" });
      await connect.getByRole("button", { name: "Not mine" }).click();
      await expect.poll(() => fixtureRequests(page, "intent-decline")).toHaveLength(1);
      await expect(connect).toContainText("Waiting for the command…");
    });

    test("a machine with no installed agents keeps checking its inventory", async ({ page }) => {
      const machine = { machineId: "machine-1", name: "Laptop", online: true, harnesses: [] };
      const connect = await openWithIntent(page, { ...base, phase: "connected", machine });
      await expect(connect).toContainText("no agent is installed there yet");
      await fixtureJson(page, "agent-installed", `**/api/xmatrix/setup-intents/${INTENT}`,
        { ...base, phase: "connected", machine: { ...machine, harnesses: [{ id: "codex", installed: true }] } });
      await expect(connect).toContainText("Found Codex");
      await expect(connect.getByRole("button", { name: "Bring it in" })).toBeVisible();
    });

    test("a finished connection can prepare a command for another machine", async ({ page }) => {
      const connect = await openWithIntent(page, { ...base, phase: "connected", registeredHarnesses: ["codex"],
        machine: { machineId: "machine-1", name: "Laptop", online: true, harnesses: [{ id: "codex", installed: true }] } });
      await expect(connect).toContainText("Your agents on Laptop are in this Space");
      const next = "abcdef0123456789abcdef0123456789";
      await fixtureJson(page, "intent-create-next", "**/api/xmatrix/setup-intents", { ...base, intentId: next, phase: "waiting" });
      await fixtureJson(page, "intent-read-next", `**/api/xmatrix/setup-intents/${next}`, { ...base, intentId: next, phase: "waiting" });
      await connect.getByRole("button", { name: "Connect another machine" }).click();
      await expect(connect).toContainText(`--connect ${next}`);
      await expect(connect).toContainText("Waiting for the command…");
    });
  });
}
