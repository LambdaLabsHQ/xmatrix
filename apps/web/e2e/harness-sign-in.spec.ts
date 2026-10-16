import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, fixtureRequestBodies, fixtureRule,
  installWorkspaceStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const MACHINE = "machine:sign-in";
const START = "harness:00000000-0000-4000-8000-0000000000a1";
const FINISH = "harness:00000000-0000-4000-8000-0000000000a2";
const daemon = {
  id: "daemon-sign-in", userId: "e2e-user", email: "e2e@xmatrix.test", name: "Studio",
  machineId: MACHINE, machineName: "Studio", hostId: "host-studio", hostName: "Studio", status: "online",
  connectedAt: E2E_NOW, lastSeenAt: new Date().toISOString(), daemonVersion: "0.16.900",
  metadata: { platform: "linux", capabilities: ["machine_harness_action_v1", "machine_harness_login_v1", "machine_harness_login_start_cancel_v1"],
    harnesses: { schemaVersion: 1, capturedAt: E2E_NOW, items: [
      { id: "codex", installed: true, probeStatus: "ok", version: "0.159.2", login: "signed_out" },
      { id: "claude", installed: true, probeStatus: "ok", version: "2.1.292", login: "signed_in" },
    ] } },
};

function registration(harness: string, displayName: string) {
  return {
    key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: MACHINE, harness },
    displayName, ownerName: "E2E Tester", machineName: "Studio", version: 1, state: "enabled", models: [],
    routingReady: true, canManageOwnerGrant: true, canConfigureSpace: true, canRemoveFromSpace: true,
    live: { machine: { online: true, platform: "linux" }, running: [] },
  };
}

async function openAgent(page: Parameters<typeof installWorkspaceStubs>[0], name: string, canCancelStart = true) {
  const registrations = [registration("codex", "codex-studio"), registration("claude", "claude-studio")];
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], machineDaemons: [{ ...daemon, metadata: { ...daemon.metadata,
    capabilities: daemon.metadata.capabilities.filter((capability) => canCancelStart || capability !== "machine_harness_login_start_cancel_v1") } }] });
  await fixtureJson(page, "sign-in-catalog", /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?quota=refresh)?$/, {
    registrations,
    capabilities: ["claude", "codex"].map((harness) => ({ harness, models: [],
      locations: registrations.filter((item) => item.key.harness === harness) })),
  });
  await fixtureRule(page, { id: "sign-in-issue", pattern: "**/api/xmatrix/machine-daemons/harness-actions", method: "POST",
    responder: { kind: "sequence", responses: [{ status: 202, json: { controlId: START, status: "queued" } },
      { status: 202, json: { controlId: FINISH, status: "queued" } }] } });
  await page.goto("/app/personal-sspaceperso/agents");
  await page.locator('[data-testid="agent-row"]').filter({ hasText: name }).click();
  return page.getByTestId("harness-sign-in");
}

test("a device-code sign-in shows its link and code, then waits for the browser on its own", async ({ page }) => {
  const section = await openAgent(page, "codex-studio");
  await expect(section).toContainText("Not signed in");
  await fixtureJson(page, "sign-in-start", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(START)}`, {
    controlId: START, presetId: "codex", action: "login_start", status: "succeeded",
    result: { presetId: "codex", action: "login_start", status: "succeeded", login: { state: "awaiting_user",
      flow: "device_code", verificationUri: "https://auth.openai.com/codex/device", userCode: "I3YY-8QZ91" } } });
  await fixtureJson(page, "sign-in-finish", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(FINISH)}`, {
    controlId: FINISH, presetId: "codex", action: "login_finish", status: "running" });
  await section.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(section.getByTestId("harness-sign-in-code")).toHaveText("I3YY-8QZ91");
  await expect(section.getByRole("link", { name: "https://auth.openai.com/codex/device", exact: true }))
    .toHaveAttribute("href", "https://auth.openai.com/codex/device");
  await expect(section).toContainText("Waiting for you to finish in the browser");
  await expect(section.getByRole("textbox")).toHaveCount(0);
  await expect.poll(() => fixtureRequestBodies(page, "sign-in-issue")).toEqual([
    { machineId: MACHINE, hostId: "host-studio", presetId: "codex", action: "login_start" },
    { machineId: MACHINE, hostId: "host-studio", presetId: "codex", action: "login_finish" },
  ]);
  await page.screenshot({ path: test.info().outputPath("sign-in-device-code.png") });
});

test("a paste-code sign-in hands back the pasted code and settles signed in", async ({ page }) => {
  const section = await openAgent(page, "claude-studio");
  await expect(section).toContainText("Signed in");
  await fixtureJson(page, "sign-in-start", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(START)}`, {
    controlId: START, presetId: "claude", action: "login_start", status: "succeeded",
    result: { presetId: "claude", action: "login_start", status: "succeeded", login: { state: "awaiting_user",
      flow: "url_paste_code", verificationUri: "https://claude.com/cai/oauth/authorize?code=true&state=e2e" } } });
  await fixtureJson(page, "sign-in-finish", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(FINISH)}`, {
    controlId: FINISH, presetId: "claude", action: "login_finish", status: "succeeded",
    result: { presetId: "claude", action: "login_finish", status: "succeeded",
      login: { state: "signed_in", flow: "url_paste_code" } } });
  await section.getByRole("button", { name: "Sign in again", exact: true }).click();
  const code = section.getByRole("textbox", { name: "Sign-in code" });
  await expect(code).toBeVisible();
  await expect(section.getByTestId("harness-sign-in-code")).toHaveCount(0);
  await code.fill("pasted#code");
  await page.screenshot({ path: test.info().outputPath("sign-in-paste-code.png") });
  await section.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(section).toContainText("Signed in.");
  await expect(code).toHaveCount(0);
  expect((await fixtureRequestBodies(page, "sign-in-issue")).at(-1)).toEqual(
    { machineId: MACHINE, hostId: "host-studio", presetId: "claude", action: "login_finish", code: "pasted#code" });
});


test("a queued sign-in explains the wait and can be cancelled before a link arrives", async ({ page }) => {
  const section = await openAgent(page, "codex-studio");
  await fixtureJson(page, "sign-in-start", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(START)}`, {
    controlId: START, presetId: "codex", action: "login_start", status: "queued" });
  await fixtureJson(page, "sign-in-cancel", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(FINISH)}`, {
    controlId: FINISH, presetId: "codex", action: "login_cancel", status: "succeeded",
    result: { login: { state: "cancelled" } } });
  await page.clock.install();
  await section.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(section.getByRole("button", { name: "Starting sign-in…" })).toBeVisible();
  await page.clock.fastForward(61_000);
  await expect(section).toContainText("The machine has not picked up this sign-in request yet");
  await expect(section.getByRole("button", { name: "Sign-in pending" })).toBeVisible();
  await section.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(section.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  expect((await fixtureRequestBodies(page, "sign-in-issue")).at(-1)?.action).toBe("login_cancel");
});

test("a failed status read offers recovery without issuing a second sign-in", async ({ page }) => {
  const section = await openAgent(page, "codex-studio");
  await fixtureJson(page, "sign-in-start", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(START)}`,
    { error: "temporarily unavailable" }, { status: 503 });
  await section.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(section).toContainText("Status could not be checked");
  await expect(section.getByRole("button", { name: "Starting sign-in…" })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  await fixtureJson(page, "sign-in-start", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(START)}`, {
    controlId: START, presetId: "codex", action: "login_start", status: "failed", error: "No sign-in link was returned." });
  await section.getByRole("button", { name: "Check status again" }).click();
  await expect(section).toContainText("No sign-in link was returned.");
  await expect(section.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  expect(await fixtureRequestBodies(page, "sign-in-issue")).toHaveLength(1);
});

test("the observation deadline ends the spinner without claiming the remote sign-in ended", async ({ page }) => {
  const section = await openAgent(page, "codex-studio");
  await fixtureJson(page, "sign-in-start", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(START)}`, {
    controlId: START, presetId: "codex", action: "login_start", status: "running" });
  await page.clock.install();
  await section.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(section.getByRole("button", { name: "Starting sign-in…" })).toBeVisible();
  await page.clock.fastForward(20 * 60_000 + 1_000);
  await expect(section).toContainText("Stopped checking after 20 minutes");
  await expect(section.getByRole("button", { name: "Starting sign-in…" })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  expect(await fixtureRequestBodies(page, "sign-in-issue")).toHaveLength(1);
});


test("an older daemon keeps status recovery but does not offer unsupported startup cancellation", async ({ page }) => {
  const section = await openAgent(page, "codex-studio", false);
  await fixtureJson(page, "sign-in-start", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(START)}`,
    { error: "temporarily unavailable" }, { status: 503 });
  await section.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(section).toContainText("Update this machine's xMatrix daemon to cancel before its sign-in link arrives.");
  await expect(section.getByRole("button", { name: "Cancel sign-in" })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Starting sign-in…" })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Check status again" })).toBeEnabled();
  expect(await fixtureRequestBodies(page, "sign-in-issue")).toHaveLength(1);
});
