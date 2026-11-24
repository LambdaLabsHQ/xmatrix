import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, fixtureRequestBodies, fixtureRule,
  installWorkspaceStubs } from "./workspace-fixtures";

// Cursor has no official quota interface: its quota stays unknown until the
// machine's owner allows reading its sign-in there. Only that owner sees the
// action, the confirmation says what is read and what never leaves the
// computer, and the read is stopped from the same place or from Settings.
test.use(E2E_DESKTOP_CONTEXT);
const MACHINE = "machine:quota-access";
const ACTION = "harness:00000000-0000-4000-8000-0000000000b1";

type InventoryItem = Record<string, unknown>;

function daemon(quotaAccess: "granted" | "not_granted", extra: InventoryItem[] = []) {
  return {
    id: "daemon-quota-access", userId: "e2e-user", email: "e2e@xmatrix.test", name: "Studio",
    machineId: MACHINE, machineName: "Studio", hostId: "host-studio", hostName: "Studio", status: "online",
    connectedAt: E2E_NOW, lastSeenAt: new Date().toISOString(), daemonVersion: "0.16.900",
    metadata: { platform: "linux", capabilities: ["machine_harness_action_v1", "machine_harness_quota_access_v1"],
      harnesses: { schemaVersion: 1, capturedAt: E2E_NOW, items: [
        { id: "cursor", installed: true, probeStatus: "ok", version: "2026.11.20", login: "signed_in", quotaAccess },
        ...extra,
      ] } },
  };
}

function cursor(ownerUserId: string, harness = "cursor") {
  return {
    key: { spaceId: E2E_SPACE.id, ownerUserId, machineId: MACHINE, harness },
    displayName: `${harness}-studio`, ownerName: ownerUserId === "e2e-user" ? "E2E Tester" : "Someone Else",
    machineName: "Studio", version: 1, state: "enabled", models: [],
    routingReady: true, canManageOwnerGrant: ownerUserId === "e2e-user", canConfigureSpace: true, canRemoveFromSpace: true,
    live: { machine: { online: true, platform: "linux" }, running: [] },
  };
}

async function openCursor(page: Parameters<typeof installWorkspaceStubs>[0], ownerUserId: string,
  harness = "cursor", extra: InventoryItem[] = []) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE],
    machineDaemons: ownerUserId === "e2e-user" ? [daemon("not_granted", extra)] : [] });
  const registrations = [cursor(ownerUserId, harness)];
  await fixtureJson(page, "quota-access-catalog", /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?quota=refresh)?$/, {
    registrations, capabilities: [{ harness, models: [], locations: registrations }],
  });
  await page.goto("/app/personal-sspaceperso/agents");
  await page.locator('[data-testid="agent-row"]').filter({ hasText: `${harness}-studio` }).click();
  await page.getByTestId("fleet-cell-open-agent").click();
  return page.locator(".app-tool-detail").getByTestId("harness-quota-access");
}

test("the owner reads Unknown, confirms what is read, and allows it on that machine", async ({ page }) => {
  const section = await openCursor(page, "e2e-user");
  await expect(section).toContainText("Quota: Unknown");
  await fixtureRule(page, { id: "quota-access-issue", pattern: "**/api/xmatrix/machine-daemons/harness-actions", method: "POST",
    responder: { kind: "sequence", responses: [{ status: 202, json: { controlId: ACTION, status: "queued" } }] } });
  await fixtureJson(page, "quota-access-status", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(ACTION)}`, {
    controlId: ACTION, presetId: "cursor", action: "quota_access_on", status: "succeeded",
    result: { presetId: "cursor", action: "quota_access_on", status: "succeeded",
      item: { id: "cursor", installed: true, probeStatus: "ok", version: "2026.11.20", quotaAccess: "granted" } } });
  await section.getByRole("button", { name: "Allow reading Cursor sign-in to show quota" }).click();
  const consent = page.getByTestId("quota-access-consent");
  for (const promise of ["only on this computer", "only to ask Cursor for its own usage",
    "Nothing from the sign-in leaves this computer", "turn this off at any time"]) {
    await expect(consent).toContainText(promise);
  }
  await page.screenshot({ path: test.info().outputPath("quota-access-consent.png") });
  await page.getByRole("button", { name: "Allow on Studio" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "quota-access-issue")).toEqual([
    { machineId: MACHINE, hostId: "host-studio", presetId: "cursor", action: "quota_access_on" },
  ]);
});

test("someone else's Cursor reads Unknown with no action to allow it", async ({ page }) => {
  const section = await openCursor(page, "someone-else");
  await expect(section).toContainText("Quota: Unknown");
  await expect(section.getByRole("button")).toHaveCount(0);
});

test("Settings lists where a sign-in is read and stops it there", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], machineDaemons: [daemon("granted")] });
  await fixtureRule(page, { id: "quota-access-revoke", pattern: "**/api/xmatrix/machine-daemons/harness-actions", method: "POST",
    responder: { kind: "sequence", responses: [{ status: 202, json: { controlId: ACTION, status: "queued" } }] } });
  await fixtureJson(page, "quota-access-revoked", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(ACTION)}`, {
    controlId: ACTION, presetId: "cursor", action: "quota_access_off", status: "succeeded",
    result: { presetId: "cursor", action: "quota_access_off", status: "succeeded" } });
  await page.goto("/app/personal-sspaceperso/settings?section=legal");
  const settings = page.getByTestId("quota-access-settings");
  await expect(settings).toContainText("Cursor on Studio");
  await settings.getByRole("button", { name: "Stop reading" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "quota-access-revoke")).toEqual([
    { machineId: MACHINE, hostId: "host-studio", presetId: "cursor", action: "quota_access_off" },
  ]);
});

// OpenCode reports its own quota from 2.2.0 on; before that it is read like
// Cursor, only under its owner's grant, and the daemon says which applies.
test("OpenCode before 2.2.0 offers its owner the same grant", async ({ page }) => {
  const section = await openCursor(page, "e2e-user", "opencode", [
    { id: "opencode", installed: true, probeStatus: "ok", version: "1.19.6", quotaAccess: "not_granted" },
  ]);
  await expect(section).toContainText("Quota: Unknown");
  await expect(section).toContainText("OpenCode before 2.2.0 has no official quota interface");
  await section.getByRole("button", { name: "Allow reading OpenCode sign-in to show quota" }).click();
  await expect(page.getByTestId("quota-access-consent")).toContainText("only to ask OpenCode for its own usage");
});

test("an expired OpenCode sign-in reads Unknown and says so", async ({ page }) => {
  const section = await openCursor(page, "e2e-user", "opencode", [
    { id: "opencode", installed: true, probeStatus: "ok", version: "1.19.6", quotaAccess: "granted", quotaSignIn: "expired" },
  ]);
  await expect(section).toContainText("OpenCode's sign-in has expired");
  await expect(section.getByRole("button", { name: "Stop reading" })).toBeVisible();
});

test("OpenCode 2.2.0 and later offer no grant", async ({ page }) => {
  await openCursor(page, "e2e-user", "opencode", [
    { id: "opencode", installed: true, probeStatus: "ok", version: "2.4.1" },
  ]);
  await expect(page.locator(".app-tool-detail")).toBeVisible();
  await expect(page.getByTestId("harness-quota-access")).toHaveCount(0);
});
