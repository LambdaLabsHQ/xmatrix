import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, installWorkspaceStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

test("same-name Agents collapse to one shout without offering retired launch suffixes", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL],
    registrations: ["MacBook", "Server"].map((machineName, index) => ({
      key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: `machine-${index}`, harness: "codex" },
      displayName: "codex", machineName,
    })),
  });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  const draft = page.locator("textarea.composer-textarea").first();
  await draft.fill("@codex");
  const choices = page.locator(".app-mention-suggestions").getByRole("option");
  await expect(choices.filter({ hasText: "codex" })).toHaveCount(1);
  await expect(choices.filter({ hasText: "MacBook" })).toHaveCount(0);
  await expect(choices.filter({ hasText: "Server" })).toHaveCount(0);
  await choices.filter({ hasText: "codex" }).click();
  await expect(draft).toHaveValue("@codex ");
  await expect(page.getByLabel("Task launch conditions")).toHaveCount(0);
  await expect(choices.filter({ hasText: "Start persistent instance" })).toHaveCount(0);
  await expect(choices.filter({ hasText: "Run one-shot task" })).toHaveCount(0);

  await expect(page.getByLabel("Task launch conditions")).toHaveCount(0);
  await expect(draft).toHaveValue("@codex ");
});

test("selected completion option is one full-width bar", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL],
    registrations: [{
      key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "machine-0", harness: "codex" },
      displayName: "codex", machineName: "MacBook",
    }],
  });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  const draft = page.locator("textarea.composer-textarea").first();
  await draft.fill("@codex");
  const panel = page.locator(".app-mention-suggestions");
  const option = panel.getByRole("option").filter({ hasText: "codex" }).first();
  await expect(option).toBeVisible();
  await expect(option).toHaveAttribute("aria-selected", "true");

  const geometry = await option.evaluate((element) => {
    const panel = element.closest(".app-mention-suggestions");
    if (!panel) return null;
    const optionBox = element.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      radius: style.borderRadius,
      background: style.backgroundColor,
      optionLeft: optionBox.left,
      optionRight: optionBox.right,
      panelLeft: panelBox.left,
      panelRight: panelBox.right,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry!.radius === "0px" || geometry!.radius === "0px 0px 0px 0px").toBe(true);
  expect(geometry!.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(Math.abs(geometry!.optionLeft - geometry!.panelLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry!.optionRight - geometry!.panelRight)).toBeLessThanOrEqual(1);
});

test("message headers and the details rail distinguish same-name Agents by owner and machine", async ({ page }) => {
  // Two registrations of the same harness and name on different owners' machines.
  const agents = ["MacBook", "Server"].map((hostName, index) => ({
    instanceId: `channel-general:${index + 1}`, ownerUserId: `owner-${index}`, hostName,
    registration: { ownerUserId: `owner-${index}`, machineId: `machine:${hostName}`, harness: "codex" },
  }));
  const members = agents.map((agent, index) => ({ userId: agent.ownerUserId, name: `Owner ${index}`,
    email: `owner-${index}@example.test`, role: "member", joinedAt: E2E_NOW }));
  const channel = { ...E2E_CHANNEL, messageCount: 2, lastMessageSequence: 2,
    memberPresence: Object.fromEntries(agents.map((agent) => [agent.instanceId, {
      kind: "agent", status: "busy", label: "codex", registration: agent.registration, instances: [{
        id: agent.instanceId, channelInstanceId: agent.instanceId.split(":")[1], label: "codex", status: "busy",
        hostName: agent.hostName, connectedAt: E2E_NOW, lastSeenAt: E2E_NOW,
      }],
    }])) };
  await installWorkspaceStubs(page, { spaces: [{ ...E2E_SPACE, members: [...E2E_SPACE.members, ...members] }],
    channels: [channel], registrations: agents.map((agent, index) => ({
      key: { spaceId: E2E_SPACE.id, ...agent.registration }, displayName: "codex", machineName: `Chosen Machine ${index}`,
    })) });
  await fixtureJson(page, "identity-label-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: agents.map((agent, index) => ({ messageId: `message-${index}`, channelId: E2E_CHANNEL.id,
      sequence: index + 1, body: `Report from machine ${index}`, sentAt: E2E_NOW,
      from: { kind: "agent", identityId: `agent:${agent.instanceId}`, agentId: agent.instanceId,
        userId: agent.ownerUserId, email: "", label: "codex", agentName: "codex", instanceId: agent.instanceId,
        channelInstanceId: agent.instanceId.split(":")[1], instanceLabel: "codex" },
    })), hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  for (const [index] of agents.entries()) {
    const row = page.locator(".app-message-row", { hasText: `Report from machine ${index}` });
    const labels = row.locator(".app-agent-identity-labels");
    // The icon names the field, so the tag carries the value alone — no "owner:" prefix.
    await expect(labels.locator("[data-status-chip=owner]")).toHaveText(`Owner ${index}`);
    await expect(labels.locator("[data-status-chip=machine]")).toHaveText(`Chosen Machine ${index}`);
    await expect(labels).not.toContainText(`Owner ${1 - index}`);
    // The time is a property of the message, so it comes before every tag the
    // sender happens to carry — identity tags included.
    await expect.poll(() => row.evaluate((element) => {
      const time = element.querySelector(".app-message-timestamp");
      const tags = Array.from(element.querySelectorAll(
        ".app-agent-identity-labels, .app-status-chip-badge, .app-sender-kind-badge, .app-message-branch-badge",
      ));
      if (!time || tags.length === 0) return "no tags rendered";
      const before = tags.every((tag) => (time.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      return before ? "time first" : "a tag precedes the time";
    })).toBe("time first");
    const railLabels = page.locator(".app-details .app-agent-identity-labels").filter({ hasText: `Owner ${index}` });
    await expect(railLabels.locator("[data-status-chip=machine]")).toHaveText(`Chosen Machine ${index}`);
  }
});

test("a Machine tag ignores disk for its fill but shows disk in its hover details", async ({ page }) => {
  const instanceId = "channel-general:1";
  const registration = { ownerUserId: "e2e-user", machineId: "machine:grok", harness: "codex" };
  const channel = { ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1,
    memberPresence: { [instanceId]: { kind: "agent", status: "busy", label: "codex", registration, instances: [{
      id: instanceId, channelInstanceId: "1", label: "codex", status: "busy", hostName: "grok",
      connectedAt: E2E_NOW, lastSeenAt: E2E_NOW,
    }] } } };
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel], registrations: [{
    key: { spaceId: E2E_SPACE.id, ...registration }, displayName: "codex", machineName: "Grok",
    live: { machine: { online: true, resources: { observedAt: E2E_NOW, cpuUsagePercent: 40,
      memoryTotalBytes: 100, memoryAvailableBytes: 40, diskTotalBytes: 100, diskAvailableBytes: 5 } }, running: [] },
  }] });
  await fixtureJson(page, "machine-load-tag-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [{ messageId: "message-0", channelId: E2E_CHANNEL.id, sequence: 1, body: "Report from grok", sentAt: E2E_NOW,
      from: { kind: "agent", identityId: `agent:${instanceId}`, agentId: instanceId, userId: "e2e-user", email: "",
        label: "codex", agentName: "codex", instanceId, channelInstanceId: "1", instanceLabel: "codex" } }],
    hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  const row = page.locator(".app-message-row", { hasText: "Report from grok" });
  const tag = row.locator("[data-machine-load-tag]");
  await expect(tag.locator("[data-status-chip=machine]")).toHaveText("Grok");
  const fill = tag.locator("[data-status-chip=machine] .app-usage-meter-fill");
  await expect(fill).toHaveAttribute("data-tone", "green");
  await expect(fill).toHaveAttribute("style", /width:\s*60%/);
  await expect(page.locator("[data-machine-load-tip]")).toHaveCount(0);
  await tag.hover();
  const tip = page.locator("[data-machine-load-tip]");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Grok");
  await expect(tip.getByTestId("machine-load-glance")).toHaveAttribute("aria-label", "CPU 40%, Mem 60%, Disk 95%");
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);
});

test("the details rail tags where an Agent works: repository when there is one, path otherwise", async ({ page }) => {
  const machineId = "machine-legend";
  const profile = {
    id: "agent:owner:profile-0", spaceId: E2E_SPACE.id, userId: "owner-0",
    name: "claude", type: "claude_code", lifetime: "short", email: "agent-0@example.test",
    metadata: { hostName: "Workstation", machineId }, createdAt: E2E_NOW, updatedAt: E2E_NOW,
  };
  // A repo summon lands in a pool slot, so the path says nothing a human wants.
  const repoCwd = "/Users/dev/.config/xmatrix/repo-pools/b43d69/slots/77961a92";
  const plainCwd = "/Users/dev/code/scratchpad";
  const instance = (suffix: string, cwd: string) => ({
    id: `instance-${suffix}`, channelInstanceId: suffix, label: `claude:${suffix}`, status: "busy",
    hostName: "Workstation", machineId, cwd, connectedAt: E2E_NOW, lastSeenAt: E2E_NOW,
  });
  await installWorkspaceStubs(page, {
    spaces: [{ ...E2E_SPACE, members: [...E2E_SPACE.members, { userId: "owner-0", name: "Legend Wang",
      email: "owner-0@example.test", role: "member", joinedAt: E2E_NOW }] }],
    channels: [{ ...E2E_CHANNEL, memberPresence: { [profile.id]: { kind: "agent", status: "busy",
      label: "claude", instances: [instance("1", repoCwd), instance("2", plainCwd)] } } }],
    workspaces: [{
      ownerUserId: "owner-0", machineId, hostId: "Workstation", hostName: "Workstation",
      canonicalCwd: repoCwd, displayName: "77961a92",
      gitRemote: "https://github.com/LambdaLabsHQ/xmatrix.git",
      runtimesSeen: [], boundChannelIds: [E2E_CHANNEL.id], visibility: "private",
      createdAt: E2E_NOW, updatedAt: E2E_NOW, lastSeenAt: E2E_NOW, metadata: {},
    }],
  });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  const rail = page.locator(".app-details");
  await expect(rail.locator("[data-status-chip=repo]")).toHaveText("LambdaLabsHQ/xmatrix");
  await expect(rail.locator("[data-status-chip=workspace]")).toHaveText("code/scratchpad");
  // The machine is its own tag; the working directory never repeats it.
  await expect(rail.locator("[data-status-chip=workspace]")).not.toContainText("Workstation");
});

test("a historical failure notice displays the current Machine name rather than its old hostname", async ({ page }) => {
  const machineId = "machine:grok";
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [{ ...E2E_CHANNEL, messageCount: 1 }],
    registrations: [{ key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId, harness: "grok" },
      displayName: "grok", machineName: "Grok Bot Machine" }],
  });
  await fixtureJson(page, "machine-name-failure-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [{ messageId: "machine-failure", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW,
      body: "Couldn't start @grok on cursor during wrapper_startup_failed.\n\nAuthentication required.",
      metadata: { source: "machine_run_failure", xmatrixSystemNotice: true, xmatrixProvenance: "system_fact",
        machineId, machineOwnerUserId: "e2e-user" },
      from: { kind: "user", identityId: "user:e2e-user", userId: "e2e-user", email: "e2e@xmatrix.test", label: "xMatrix" },
    }], hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  const notice = page.locator('[data-system-notice="machine_run_failure"]');
  await expect(notice).toContainText("@grok · Grok Bot Machine");
  await expect(notice).not.toContainText("cursor");
});

test("a Machine tag and its hover card open that Machine's page, only for a Machine the reader can open", async ({ page }) => {
  const agents = [
    { instanceId: "channel-general:1", channelInstanceId: "1", hostName: "grok", machineName: "Grok",
      registration: { ownerUserId: "e2e-user", machineId: "machine:grok", harness: "codex" } },
    // Someone else's Machine: the reader's Machines view has no page for it.
    { instanceId: "channel-general:2", channelInstanceId: "2", hostName: "elsewhere", machineName: "Elsewhere",
      registration: { ownerUserId: "owner-1", machineId: "machine:elsewhere", harness: "codex" } },
  ];
  const channel = { ...E2E_CHANNEL, messageCount: 2, lastMessageSequence: 2,
    memberPresence: Object.fromEntries(agents.map((agent) => [agent.instanceId, { kind: "agent", status: "busy",
      label: "codex", registration: agent.registration, instances: [{ id: agent.instanceId,
        channelInstanceId: agent.channelInstanceId, label: "codex", status: "busy", hostName: agent.hostName,
        connectedAt: E2E_NOW, lastSeenAt: E2E_NOW }] }])) };
  await installWorkspaceStubs(page, {
    spaces: [{ ...E2E_SPACE, members: [...E2E_SPACE.members, { userId: "owner-1", name: "Owner 1",
      email: "owner-1@example.test", role: "member", joinedAt: E2E_NOW }] }],
    channels: [channel],
    registrations: agents.map((agent) => ({ key: { spaceId: E2E_SPACE.id, ...agent.registration },
      displayName: "codex", machineName: agent.machineName,
      live: { machine: { online: true, resources: { observedAt: E2E_NOW, cpuUsagePercent: 40,
        memoryTotalBytes: 100, memoryAvailableBytes: 40, diskTotalBytes: 100, diskAvailableBytes: 50 } }, running: [] },
    })),
    machineDaemons: [{ id: "daemon-grok", userId: "e2e-user", email: "e2e@xmatrix.test", name: "daemon-grok",
      status: "online", machineId: "machine:grok", machineName: "Grok", hostId: "grok", hostName: "grok",
      daemonVersion: "0.16.600", cliVersion: "0.16.600", connectedAt: E2E_NOW, lastSeenAt: new Date().toISOString(),
      metadata: { platform: "linux" } }],
  });
  await fixtureJson(page, "machine-link-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: agents.map((agent, index) => ({ messageId: `message-${index}`, channelId: E2E_CHANNEL.id,
      sequence: index + 1, body: `Report from ${agent.hostName}`, sentAt: E2E_NOW,
      from: { kind: "agent", identityId: `agent:${agent.instanceId}`, agentId: agent.instanceId,
        userId: agent.registration.ownerUserId, email: "", label: "codex", agentName: "codex",
        instanceId: agent.instanceId, channelInstanceId: agent.channelInstanceId, instanceLabel: "codex" } })),
    hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  const ownTag = page.locator(".app-message-row", { hasText: "Report from grok" }).locator("[data-machine-load-tag]");
  const otherTag = page.locator(".app-message-row", { hasText: "Report from elsewhere" }).locator("[data-machine-load-tag]");
  await expect(ownTag.locator("[data-status-chip=machine]")).toHaveText("Grok");
  await expect(ownTag).toHaveAttribute("role", "link");
  await expect(otherTag.locator("[data-status-chip=machine]")).toHaveText("Elsewhere");
  await expect(otherTag).not.toHaveAttribute("role", "link");
  await expect(otherTag).not.toHaveAttribute("data-machine-link", /.*/);

  // The card stays up while the pointer crosses into it, and clicking it opens the Machine.
  await ownTag.hover();
  const tip = page.locator("[data-machine-load-tip]");
  await expect(tip).toContainText("Grok");
  await tip.click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/machines\?item=machine%3Agrok$/);
  await expect(page.locator('[data-testid="machine-row"]').filter({ hasText: "Grok" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Grok" })).toBeVisible();

  // The tag itself opens the same page.
  await page.goBack();
  await ownTag.locator("[data-status-chip=machine]").click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/machines\?item=machine%3Agrok$/);
});
