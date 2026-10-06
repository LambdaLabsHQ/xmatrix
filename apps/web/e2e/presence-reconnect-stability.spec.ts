import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_NOW,
  E2E_SPACE,
  fixtureJson,
  fixtureRule,
  installWorkspaceStubs,
} from "./workspace-fixtures";

test.use({
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

const avatarUrl = "/agent-vendors/openai.svg";
const agentId = "agent:codex";
const instanceId = "instance-codex-reconnect";
const messageBody = "Presence survives the Human socket reconnect.";

const agentPresence = {
  kind: "agent" as const,
  label: "Codex",
  avatarUrl,
  instances: [{
    id: instanceId,
    channelInstanceId: "1",
    channelId: E2E_CHANNEL.id,
    label: "Codex:1",
    connectedAt: E2E_NOW,
    lastSeenAt: E2E_NOW,
    status: "busy" as const,
    activity: "Working",
  }],
};

const channel = {
  ...E2E_CHANNEL,
  messageCount: 1,
  historyHeadSequence: 1,
  memberPresence: { [agentId]: agentPresence },
};

const message = {
  messageId: "message-presence-reconnect",
  channelId: E2E_CHANNEL.id,
  sequence: 1,
  body: messageBody,
  sentAt: E2E_NOW,
  from: {
    identityId: agentId,
    kind: "agent" as const,
    label: "Codex:1",
    userId: "agent-owner",
    email: "codex@xmatrix.test",
    agentName: "Codex",
    instanceId,
    channelInstanceId: "1",
    instanceLabel: "Codex:1",
    avatarUrl,
  },
};

test("Human WebSocket reconnect keeps the Agent Instance and historical avatar stable", async ({ page }) => {
  const sockets: Array<{ close(options?: { code?: number; reason?: string }): void }> = [];
  await page.routeWebSocket("**/ws/humans*", (socket) => {
    sockets.push(socket);
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw)) as { type?: string; requestId?: string };
      if (request.type !== "human_connect") return;
      socket.send(JSON.stringify({
        type: "human_connected",
        requestId: request.requestId,
        user: { id: "e2e-user", email: "e2e@xmatrix.test", name: "E2E Tester" },
      }));
    });
  });

  await installWorkspaceStubs(page, {
    spaces: [E2E_SPACE],
    channels: [channel],
  });
  await fixtureRule(page, {
    id: "reconnect-channel-catalog",
    pattern: /\/api\/xmatrix\/channels(?:\?.*)?$/,
    responder: {
      kind: "sequence",
      responses: [
        {
          json: {
            channels: [channel],
            catalogSync: {
              protocolVersion: 1,
              token: "catalog-before-reconnect",
              complete: true,
              replacedSpaceIds: [E2E_SPACE.id],
              removedSpaceIds: [],
            },
          },
        },
        {
          json: {
            channels: [],
            catalogSync: {
              protocolVersion: 1,
              token: "catalog-during-reconnect",
              complete: false,
              replacedSpaceIds: [],
              removedSpaceIds: [],
            },
          },
        },
      ],
    },
  });
  await fixtureJson(
    page,
    "reconnect-history",
    "**/api/xmatrix/channels/channel-general/history**",
    { messages: [message], hasMore: false },
  );

  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });

  const workAvatar = page.locator(".app-agent-work-avatar").filter({ has: page.locator("img") });
  const messageRow = page.locator(".app-message-row", { hasText: messageBody });
  const messageAvatar = messageRow.locator(".message-author-avatar img");
  await expect(workAvatar).toHaveCount(1);
  await expect(workAvatar.locator("img")).toHaveAttribute("src", avatarUrl);
  await expect(messageAvatar).toHaveAttribute("src", avatarUrl);
  await expect.poll(() => sockets.length).toBe(1);

  sockets[0]!.close({ code: 1006, reason: "acceptance reconnect" });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expect.poll(() => sockets.length, { timeout: 10_000 }).toBeGreaterThan(1);
  await expect(workAvatar).toHaveCount(1);
  await expect(workAvatar.locator("img")).toHaveAttribute("src", avatarUrl);
  await expect(messageAvatar).toHaveAttribute("src", avatarUrl);
});
