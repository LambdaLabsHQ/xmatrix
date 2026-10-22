import { expect, test } from "./fixtures";
import { fixtureClaudePasteCodeSignIn } from "./harness-sign-in-fixtures";
import {
  E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, E2E_USER_SENDER, fixtureJson, fixtureRequestBodies, fixtureRule,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const MACHINE = "machine:mac";
const START = "harness:00000000-0000-4000-8000-0000000000b1";
const FINISH = "harness:00000000-0000-4000-8000-0000000000b2";
const CHANNEL = { ...E2E_CHANNEL, messageCount: 2, lastMessageSequence: 2, updatedAt: E2E_NOW };
const SUMMON = { messageId: "summon", channelId: CHANNEL.id, sequence: 1, body: "@auto fix the build", sentAt: E2E_NOW,
  from: { ...E2E_USER_SENDER, identityId: "user:e2e-user" } };
const signedOut = { harness: "claude", program: "Claude Code", machineId: MACHINE, machineName: "mac-mini" };
const NOTICE = { messageId: "notice", channelId: CHANNEL.id, sequence: 2, sentAt: E2E_NOW,
  body: "Agent launch failed: Claude Code on mac-mini is not signed in, so it can't take work. " +
    "Sign it in from here, then the message goes to it. No launch was allocated. (registration_harness_signed_out)",
  from: { kind: "user", identityId: "user:e2e-user", userId: "e2e-user", email: "e2e@xmatrix.test", label: "xMatrix",
    name: "xMatrix", avatarUrl: "/brand/xmatrix-management-icon.png" },
  metadata: { kind: "xmatrix.harness-signed-out.v1", signedOut, sourceMention: "@auto", sourceMessageId: "summon",
    xmatrixSystemNotice: true, xmatrixProvenance: "system_fact" } };

const CLAUDE_ITEM = { id: "claude", installed: true, probeStatus: "ok", version: "2.1.292", login: "signed_out" };

async function openRefusedSummon(page: Parameters<typeof openWorkspaceWithStubs>[0], ownerUserId = "e2e-user", notice = NOTICE,
  item: Record<string, unknown> & { id: string } = CLAUDE_ITEM) {
  const registrations = [{ key: { spaceId: E2E_SPACE.id, ownerUserId, machineId: MACHINE, harness: item.id },
    displayName: item.id, ownerName: "E2E Tester", machineName: "mac-mini", version: 1, state: "enabled", models: [],
    routingReady: true, canManageOwnerGrant: true, canConfigureSpace: true, canRemoveFromSpace: true,
    live: { machine: { online: true, platform: "macos" }, running: [] } }];
  const machineDaemons = [{ id: "daemon-mac", userId: ownerUserId, email: "e2e@xmatrix.test", name: "mac-mini",
    machineId: MACHINE, machineName: "mac-mini", hostId: "host-mac", hostName: "mac-mini", status: "online",
    connectedAt: E2E_NOW, lastSeenAt: new Date().toISOString(), daemonVersion: "1.0.562",
    metadata: { platform: "macos", capabilities: ["machine_harness_action_v1", "machine_harness_login_v1"],
      harnesses: { schemaVersion: 1, capturedAt: E2E_NOW,
        items: [item] } } }];
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], registrations, machineDaemons, channels: [CHANNEL] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, { messages: [SUMMON, notice], hasMore: false });
  await fixtureJson(page, "launch-anyway", `**/api/xmatrix/channels/${CHANNEL.id}/messages/summon/launch-anyway`,
    { launchIds: ["launch-again"] }, { method: "POST" });
  await fixtureRule(page, { id: "sign-in-issue", pattern: "**/api/xmatrix/machine-daemons/harness-actions", method: "POST",
    responder: { kind: "sequence", responses: [{ status: 202, json: { controlId: START, status: "queued" } },
      { status: 202, json: { controlId: FINISH, status: "queued" } }] } });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  return page.getByTestId("harness-signed-out-notice");
}

/** Claude Code's paste-code sign-in, finished from the notice. */
async function signInFromNotice(page: Parameters<typeof openWorkspaceWithStubs>[0], notice: ReturnType<typeof page.getByTestId>) {
  await fixtureClaudePasteCodeSignIn(page, START, FINISH);
  await notice.getByRole("button", { name: "Sign in", exact: true }).click();
  await notice.getByRole("textbox", { name: "Sign-in code" }).fill("code-from-browser");
  await notice.getByRole("button", { name: "Finish" }).click();
}

test("a summon refused for a signed-out program is signed in from its notice, then sent to it again", async ({ page }) => {
  const notice = await openRefusedSummon(page);
  await expect(notice).toContainText("Claude Code on mac-mini is not signed in, so it cannot take work yet.", { timeout: 20_000 });
  await signInFromNotice(page, notice);
  await expect(notice).toContainText("Your message went to it again.");
  // The author's own summon goes again, exactly as written.
  await expect.poll(() => fixtureRequestBodies(page, "launch-anyway"))
    .toEqual([{ body: "@auto fix the build", sourceMention: "@auto" }]);
  await page.screenshot({ path: test.info().outputPath("signed-out-notice.png") });
});

test("someone who cannot sign the program in reads the notice as written", async ({ page }) => {
  await openRefusedSummon(page, "someone-else");
  await expect(page.locator('[id="message:notice"]')).toContainText("Claude Code on mac-mini is not signed in, so it can't take work",
    { timeout: 20_000 });
  await expect(page.getByTestId("harness-signed-out-notice")).toHaveCount(0);
});

test("a turn its program refused as signed out is signed in from its notice, and asked again by the person", async ({ page }) => {
  // The failure an Agent posts: no summon of its own to send again.
  const { sourceMention: _mention, sourceMessageId: _source, ...metadata } = NOTICE.metadata;
  const notice = await openRefusedSummon(page, "e2e-user", { ...NOTICE, metadata: { ...metadata, xmatrixTurnFailure: true },
    body: "xMatrix could not complete this claude turn: Failed to authenticate: OAuth session expired and could not be refreshed" });
  await expect(notice).toContainText("Claude Code on mac-mini is not signed in", { timeout: 20_000 });
  await signInFromNotice(page, notice);
  await expect(notice).toContainText("Send your message again to continue.");
  expect(await fixtureRequestBodies(page, "launch-anyway")).toEqual([]);
});

test("a program set up only on its machine shows its own words, and a check after setting it up sends the summon again", async ({ page }) => {
  const qwen = { harness: "qwen", program: "Qwen Code", machineId: MACHINE, machineName: "mac-mini" };
  const refusal = "Missing API key for openai auth. Set the environment variable 'OPENAI_API_KEY'.";
  const notice = await openRefusedSummon(page, "e2e-user", { ...NOTICE, metadata: { ...NOTICE.metadata, signedOut: qwen } },
    { id: "qwen", installed: true, probeStatus: "ok", version: "0.26.0", login: "signed_out", loginDetail: refusal });
  await expect(notice).toContainText("Qwen Code on mac-mini can't take work yet.", { timeout: 20_000 });
  await expect(notice).toContainText(refusal);
  await expect(notice).toContainText("Run qwen in a terminal on that computer");
  await expect(notice.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  // The machine starts Qwen Code again the way a launch does, and now it opens a session.
  await fixtureJson(page, "check-again", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(START)}`, {
    controlId: START, presetId: "custom", action: "refresh", status: "succeeded",
    result: { presetId: "custom", action: "refresh", status: "succeeded", inventory: { schemaVersion: 1, capturedAt: E2E_NOW,
      items: [{ id: "qwen", installed: true, probeStatus: "ok", version: "0.26.0", login: "signed_in" }] } } });
  await notice.getByRole("button", { name: "Check again" }).click();
  await expect(notice).toContainText("Your message went to it again.", { timeout: 20_000 });
  await expect.poll(() => fixtureRequestBodies(page, "launch-anyway"))
    .toEqual([{ body: "@auto fix the build", sourceMention: "@auto" }]);
  await page.screenshot({ path: test.info().outputPath("set-up-there-notice.png") });
});
