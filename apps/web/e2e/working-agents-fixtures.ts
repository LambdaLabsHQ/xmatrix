import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_NOW,
  E2E_SPACE,
  E2E_USER_SENDER,
  fixtureJson,
  installWorkspaceStubs,
  routeHumanSocket,
} from "./workspace-fixtures";

/** `count` messages in one Channel, oldest first, one second apart. */
export function channelHistory(count: number, idPrefix: string, body: (row: number) => string, channelId = E2E_CHANNEL.id) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `${idPrefix}-${index + 1}`,
    channelId,
    sequence: index + 1,
    body: body(index + 1),
    sentAt: new Date(Date.parse(E2E_NOW) + index * 1_000).toISOString(),
    from: E2E_USER_SENDER,
    reactions: [],
    annotations: [],
    attachments: [],
  }));
}

/** A Space of `count` conversations, each with one busy Agent; conversation 0 is #general. */
export function workingAgentsSpace(count: number, prefix: string) {
  const channelId = (index: number) => (index ? `channel-${prefix}-${index}` : E2E_CHANNEL.id);
  const instance = (index: number, activity: string) => ({
    id: `instance-${prefix}-${index}`,
    channelInstanceId: "1",
    label: `agent${index}:1`,
    channelId: channelId(index),
    connectedAt: E2E_NOW,
    lastSeenAt: E2E_NOW,
    status: "busy",
    activity,
  });
  const agents = Array.from({ length: count }, (_, index) => ({
    id: `agent:${prefix}-${index}`,
    userId: "e2e-user",
    name: `agent${index}`,
    type: "codex",
    lifetime: "long",
    email: `agent${index}@xmatrix.test`,
    metadata: {},
    connectedAt: E2E_NOW,
    lastSeenAt: E2E_NOW,
    status: "busy",
    channelId: channelId(index),
    instances: [instance(index, "Working")],
  }));
  const channel = (index: number, activity: string) => ({
    ...E2E_CHANNEL,
    id: channelId(index),
    name: index ? `${prefix}-${index}` : E2E_CHANNEL.name,
    messageCount: 40,
    historyHeadSequence: 40,
    lastMessageSequence: 40,
    updatedAt: new Date(Date.parse(E2E_NOW) - index * 60_000).toISOString(),
    memberPresence: {
      [agents[index].id]: {
        kind: "agent", status: "busy", label: agents[index].name, activity, instances: [instance(index, activity)],
      },
    },
  });
  /** What the Hub sends for one status report: the Agent card and the whole Channel. */
  const report = (index: number, activity: string) => [
    { type: "enhanced_presence", agent: { ...agents[index], activity, instances: [instance(index, activity)] } },
    { type: "channel_updated", channel: channel(index, activity) },
  ];
  return { channelId, agents, channels: agents.map((_, index) => channel(index, "Working")), report };
}

/**
 * Opens #general of a working-Agents Space with `messages` as its history and
 * returns the Human socket's send, once `lastRowText` is on screen.
 */
export async function openWorkingAgentsSpace(
  page: Page,
  space: ReturnType<typeof workingAgentsSpace>,
  messages: unknown[],
  lastRowText: string,
): Promise<(frame: unknown) => void> {
  let send: ((frame: unknown) => void) | null = null;
  await routeHumanSocket(page, (frame, reply) => {
    if (frame.type === "human_connect") {
      reply({ type: "agent_list", agents: space.agents });
      send = reply;
    }
    if (frame.type === "user_focus_channel") {
      reply({
        type: "channel_history",
        requestId: frame.requestId,
        channelId: frame.channelId,
        messages: frame.channelId === E2E_CHANNEL.id ? messages : [],
        hasMore: false,
      });
    }
  });
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: space.channels });
  await fixtureJson(page, "working-agents-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages,
    hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-message-timeline").getByText(lastRowText)).toBeVisible({ timeout: 60_000 });
  if (!send) throw new Error("the Human socket never connected");
  return send;
}
