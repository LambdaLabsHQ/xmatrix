import type { Page } from "@playwright/test";

import {
  fixtureChannelCatalog,
  fixtureJson,
  fixtureRequestBodies,
  fixtureRequests,
  fixtureRule,
  installApiFixtures,
  releaseFixture,
  requestedBeforeSequences,
} from "./in-page-api-fixtures";

/* Re-exported so a spec needs one import for both the workspace fixtures and
   the rules it layers on top of them. */
export {
  fixtureChannelCatalog,
  fixtureJson,
  fixtureRequestBodies,
  fixtureRequests,
  fixtureRule,
  installApiFixtures,
  releaseFixture,
  requestedBeforeSequences,
};

export const E2E_NOW = "2026-07-01T00:00:00.000Z";

export type WorkspaceStubFixtures = {
  spaces?: unknown[];
  channels?: unknown[];
  /** The Space's Agent registrations; each Agent a composer can start. */
  registrations?: Array<{ key: { spaceId: string; ownerUserId: string; machineId: string; harness: string };
    displayName?: string; machineName?: string; models?: string[];
    modelCatalog?: Array<{ model: string; efforts: Array<{ value: string }> }>; live?: unknown }>;
  workspaces?: unknown[];
  /**
   * What the Channel's Space authorizes. Registered directories are a separate
   * fact: they reach the picker only through this answer, and only for their
   * own owner, so a spec that wants repo rows must say which repos.
   */
  launchTargets?: {
    repos?: Array<{ value: string; private?: boolean }>;
    repoStatus?: "authorized" | "not-connected" | "unavailable";
    repoStatusDetail?: string;
    workspaces?: unknown[];
  };
  machineDaemons?: unknown[];
  automations?: unknown[];
  automationResponses?: unknown[][];
  automationResponseErrors?: Array<string | null>;
  automationsError?: string;
  automationExecutionEnabled?: boolean;
  automationAgentManagementEnabled?: boolean;
  channelViewPreference?: {
    version?: number;
    childViews?: Record<string, string>;
    pinnedChannelIds?: string[];
  };
};

/* One phone context for every mobile spec, so "what mobile means" is decided
   in one place instead of drifting per file. Below the md breakpoint, which is
   what makes the desktop sidebar collapse. */
export const E2E_MOBILE_CONTEXT = {
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
  viewport: { height: 852, width: 393 },
};

/** The ordinary desktop viewport used by sidebar presentation specs. */
export const E2E_DESKTOP_CONTEXT = {
  viewport: { height: 900, width: 1280 },
  deviceScaleFactor: 1,
  hasTouch: false,
  isMobile: false,
};

export const E2E_SPACE = {
  id: "space-personal",
  name: "Personal",
  ownerId: "e2e-user",
  members: [
    { userId: "e2e-user", email: "e2e@xmatrix.test", name: "E2E Tester", role: "owner", joinedAt: E2E_NOW },
  ],
  metadata: {},
  createdAt: E2E_NOW,
  updatedAt: E2E_NOW,
};

export type HumanSocketFrame = { type?: string; channelId?: string; requestId?: string };

/**
 * Routes the Human socket: answers human_connect as the E2E user and hands
 * every frame to `onFrame` with a reply function and the 1-based connection
 * number. Frames it does not answer (ping included) go unanswered, which is
 * how a spec stands in for a socket the OS dropped.
 */
export async function routeHumanSocket(
  page: Page,
  onFrame: (frame: HumanSocketFrame, reply: (message: unknown) => void, connection: number) => void,
) {
  let connections = 0;
  await page.routeWebSocket("**/ws/humans*", (socket) => {
    const connection = ++connections;
    const reply = (message: unknown) => socket.send(JSON.stringify(message));
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as HumanSocketFrame;
      if (frame.type === "human_connect") reply({
        type: "human_connected", requestId: frame.requestId,
        user: { id: "e2e-user", email: "e2e@xmatrix.test", name: "E2E Tester" },
      });
      onFrame(frame, reply, connection);
    });
  });
  return { connections: () => connections };
}

export const E2E_CHANNEL = {
  id: "channel-general",
  spaceId: E2E_SPACE.id,
  name: "general",
  mode: "open",
  metadata: {},
  createdBy: "e2e-user",
  createdAt: E2E_NOW,
  updatedAt: E2E_NOW,
};

export const E2E_USER_SENDER = {
  kind: "user",
  label: "E2E Tester",
  userId: "e2e-user",
  email: "e2e@xmatrix.test",
};

/* Shared workspace bootstrap for shell e2e specs. Later route registrations
   win, so the catch-all goes first. Every workspace bootstrap fetch reads its
   payload defensively (data.x || []), which makes the empty-object fallback
   safe for events/projects/Automations. */
export async function openWorkspaceWithStubs(
  page: Page,
  fixtures: WorkspaceStubFixtures = {}
) {
  await installWorkspaceStubs(page, fixtures);
  // Nothing opens a Channel the reader did not ask for, so a desktop opens the
  // Space's first Channel by its address, as a reader picking it would. A
  // phone starts from the list.
  const channel = openedChannel(fixtures);
  const desktop = (page.viewportSize()?.width ?? 1280) >= 768;
  // domcontentloaded is enough: assertions wait on UI. Avoids paying full
  // window "load" (fonts/secondary assets) on every bootstrap navigation.
  await page.goto(desktop && channel
    ? `/app/${encodeURIComponent(channel.spaceId)}/channels/${encodeURIComponent(`${channel.name}--${channel.id}`)}`
    : "/app", { waitUntil: "domcontentloaded" });
}

/** The Channel a desktop reader opens first: the first one in the first Space. */
function openedChannel(fixtures: WorkspaceStubFixtures): { id: string; spaceId: string; name: string } | null {
  const channels = (fixtures.channels ?? []) as Array<{ id?: string; spaceId?: string; name?: string }>;
  const spaceId = (fixtures.spaces?.[0] as { id?: string } | undefined)?.id;
  const channel = channels.find((item) => item.spaceId === spaceId) ?? channels[0];
  return channel?.id && channel.spaceId ? { id: channel.id, spaceId: channel.spaceId, name: channel.name ?? "" } : null;
}

/** A new conversation's create and first-message endpoints, answering as this Channel;
    read back as "conversation-create" and "conversation-first-message". */
export async function fixtureConversationCreate(page: Page, channel: { id: string }) {
  await fixtureJson(page, "conversation-create", /\/api\/xmatrix\/channels$/u, { channel }, { method: "POST" });
  await fixtureJson(page, "conversation-first-message",
    new RegExp(`/api/xmatrix/channels/${channel.id}/messages$`, "u"), { message: { messageId: "m-1" } }, { method: "POST" });
}

/** Opens the app and starts a new conversation with the conversation list's +; returns the draft. */
export async function startNewConversation(page: Page) {
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await page.locator(".app-sidebar .app-list-create").click();
  return page.getByTestId("new-conversation");
}

/** The workspace fixtures plus a page tree of these titles, each at the root, in order. */
export async function installPageTreeStubs(page: Page, titles: string[]) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, {
    pages: titles.map((title, index) => ({
      pageId: `p-${title.toLowerCase()}`, parentPageId: null, title, position: String.fromCharCode(86 + index),
      accessMode: "open", headRevision: 1, agentSuggestOnly: false, canEdit: true, updatedAt: E2E_NOW,
    })),
  });
}

/**
 * The workspace fixture set without any navigation, for callers that open a
 * specific route themselves. Rules are registered in the same order the old
 * `page.route` stack used, and the in-page layer keeps the same
 * last-registered-wins precedence, so behaviour is unchanged.
 */
export async function installWorkspaceStubs(
  page: Page,
  fixtures: WorkspaceStubFixtures = {}
) {
  const automationResponses = buildAutomationResponses(fixtures);
  await installApiFixtures(page);
  await fixtureJson(page, "api-catch-all", "**/api/xmatrix/**", {});
  await fixtureJson(page, "client-compatibility", /\/api\/(?:xmatrix\/)?client-compatibility(?:\?.*)?$/, {
    compatible: true,
    code: "compatible",
    protocolVersion: 2,
    upgradeUrl: "https://xmatrix.sh/download",
  });
  await fixtureRule(page, {
    id: "automations",
    pattern: /\/api\/xmatrix\/automations(?:\?.*)?$/,
    responder: { kind: "sequence", responses: automationResponses },
  });
  await fixtureJson(page, "workspaces", /\/api\/xmatrix\/workspaces(?:\?.*)?$/, {
    workspaces: fixtures.workspaces ?? [],
  });
  await fixtureJson(page, "machine-daemons", /\/api\/xmatrix\/machine-daemons(?:\?.*)?$/, {
    daemons: fixtures.machineDaemons ?? [],
  });
  for (const daemon of (fixtures.machineDaemons ?? []) as Record<string, unknown>[]) {
    if (typeof daemon.machineId !== "string") continue;
    await fixtureJson(page, `machine-name-${daemon.machineId}`, `**/api/xmatrix/machines/${encodeURIComponent(daemon.machineId)}/name`,
      { machineId: daemon.machineId, name: daemon.machineName ?? null }, { method: "GET" });
  }
  const channels = (fixtures.channels ?? []) as Record<string, unknown>[];
  await fixtureJson(page, "channels", /\/api\/xmatrix\/channels(?:\?.*)?$/, { channels });
  await fixtureChannelCatalog(page, "channel-catalog", channels);
  await fixtureJson(page, "channel-history", "**/api/xmatrix/channels/*/history**", {
    messages: [],
    hasMore: false,
  });
  await fixtureJson(page, "spaces", "**/api/xmatrix/spaces**", {
    spaces: fixtures.spaces ?? [],
  });
  // A Space's billing is not the Space list: answer as a Hub without plans does.
  await fixtureJson(page, "space-billing", /\/api\/xmatrix\/spaces\/[^/]+\/billing$/, { error: "not found" },
    { status: 404 });
  const registrations = (fixtures.registrations ?? []).map((registration) => ({
    displayName: registration.key.harness, ownerName: "Owner", machineName: registration.key.machineId,
    version: 1, state: "enabled", models: [], routingReady: true, canManageOwnerGrant: false,
    canConfigureSpace: false, canRemoveFromSpace: false, ...registration }));
  const harnesses = [...new Set(registrations.map((registration) => registration.key.harness))];
  await fixtureJson(page, "registration-catalog", "**/api/xmatrix/spaces/*/agent-registrations", {
    registrations,
    capabilities: harnesses.map((harness) => {
      const locations = registrations.filter((registration) => registration.key.harness === harness);
      return { harness, models: [...new Set(locations.flatMap((location) => location.models))], locations };
    }),
  });
  await fixtureRule(page, {
    id: "launch-targets",
    pattern: "**/api/xmatrix/spaces/*/launch-targets**",
    responder: {
      kind: "launchTargets",
      repos: fixtures.launchTargets?.repos ?? [],
      ...(fixtures.launchTargets?.repoStatus
        ? { repoStatus: fixtures.launchTargets.repoStatus }
        : {}),
      ...(fixtures.launchTargets?.repoStatusDetail
        ? { repoStatusDetail: fixtures.launchTargets.repoStatusDetail }
        : {}),
      workspaces: (fixtures.launchTargets?.workspaces ?? fixtures.workspaces ?? []) as Array<
        Record<string, unknown>
      >,
    },
  });
  await fixtureJson(page, "channel-transfers", /\/api\/xmatrix\/spaces\/[^/]+\/channel-transfers(?:\?.*)?$/, { proposals: [] });

  await fixtureRule(page, {
    id: "channel-view-preference",
    pattern: "**/api/xmatrix/spaces/*/channel-view-preference**",
    responder: {
      kind: "channelViewPreference",
      preference: {
        spaceId: String(
          (fixtures.spaces?.[0] as { id?: unknown } | undefined)?.id || E2E_SPACE.id
        ),
        version: fixtures.channelViewPreference?.version ?? 1,
        childViews: fixtures.channelViewPreference?.childViews ?? {},
        // Pins are part of the same CAS row as child views. Omitting this
        // field from a PATCH echo is read as `[]` and wipes the optimistic pin.
        pinnedChannelIds: fixtures.channelViewPreference?.pinnedChannelIds ?? [],
      },
    },
  });
}

/**
 * Flatten the Automation fixture options into one response-per-call list.
 * The old handler resolved error/sequence/default on every request; the same
 * decision now happens once, up front, because the in-page responder only walks
 * a list.
 */
function buildAutomationResponses(fixtures: WorkspaceStubFixtures) {
  const envelope = (automations: unknown[]) => ({
    status: 200,
    json: {
      automations,
      executionEnabled: fixtures.automationExecutionEnabled ?? true,
      agentManagementEnabled: fixtures.automationAgentManagementEnabled ?? true,
    },
  });
  if (fixtures.automationsError) {
    return [{ status: 503, json: { error: fixtures.automationsError } }];
  }
  const sequence = fixtures.automationResponses;
  const errors = fixtures.automationResponseErrors;
  const length = Math.max(sequence?.length ?? 0, errors?.length ?? 0);
  if (length === 0) return [envelope(fixtures.automations ?? [])];
  return Array.from({ length }, (_, index) => {
    const error = errors?.[Math.min(index, errors.length - 1)];
    if (error) return { status: 503, json: { error } };
    const automations = sequence?.[Math.min(index, sequence.length - 1)] ?? fixtures.automations ?? [];
    return envelope(automations);
  });
}

export async function openGeneralChannelWithHistory(
  page: Page,
  channel: unknown,
  messages: unknown[],
  additionalChannels: unknown[] = [],
) {
  await installWorkspaceStubs(page, {
    spaces: [E2E_SPACE], channels: [channel, ...additionalChannels],
  });
  await fixtureJson(
    page,
    "channel-general-history",
    "**/api/xmatrix/channels/channel-general/history**",
    { messages, hasMore: false }
  );
  // One navigation: the fixtures are already in place, so there is nothing to
  // gain from loading /app first and immediately leaving it.
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", {
    waitUntil: "domcontentloaded",
  });
}

/* Keyset history stub shared by every spec that needs more than one page:
   `beforeSequence` is exclusive, so a request for S returns the newest page of
   messages older than S. Each requested cursor is recorded so a spec can assert
   which page (or seek) the app actually asked for. */
export const CHANNEL_HISTORY_PAGES_RULE = "channel-general-history-pages";

export async function routeChannelHistoryPages(
  page: Page,
  history: ReadonlyArray<{ sequence: number }>,
) {
  await fixtureRule(page, {
    id: CHANNEL_HISTORY_PAGES_RULE,
    pattern: "**/api/xmatrix/channels/channel-general/history**",
    responder: { kind: "pagedHistory", messages: history },
  });
}

/**
 * A server whose first page is short but still reports `hasMore`. Proves the
 * client follows the server's continuation cursor rather than counting the rows
 * it happened to receive.
 */
export async function sparseHeadChannelHistory(
  page: Page,
  history: ReadonlyArray<{ sequence: number }>,
  firstPage: ReadonlyArray<{ sequence: number }>,
) {
  await fixtureRule(page, {
    id: CHANNEL_HISTORY_PAGES_RULE,
    pattern: "**/api/xmatrix/channels/channel-general/history**",
    responder: { kind: "pagedHistory", mode: "sparse-head", messages: history, firstPage },
  });
}

/**
 * The `beforeSequence` cursors the app asked this channel's history for. Reads
 * the in-page request log, so it is a promise where the old Node-side array was
 * synchronous — poll it rather than reading it once.
 */
export async function requestedHistoryCursors(page: Page) {
  return requestedBeforeSequences(page, CHANNEL_HISTORY_PAGES_RULE);
}

/* A long, uniform channel history. Long on purpose: the first page is only a
   small tail of it, which is what makes paging and jumping observable at all. */
export function channelHistoryFixture(count: number, idPrefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `${idPrefix}-${index + 1}`,
    channelId: E2E_CHANNEL.id,
    sequence: index + 1,
    body: `Message ${index + 1}. ${"Channel history content. ".repeat(2)}`,
    sentAt: new Date(Date.parse(E2E_NOW) + index * 1_000).toISOString(),
    from: E2E_USER_SENDER,
  }));
}

/* Open #general against a keyset-paged history. Which pages - or seeks - the
   app asked for is read back with `requestedHistoryCursors(page)`. */
export async function openGeneralChannelWithPagedHistory(
  page: Page,
  history: ReadonlyArray<{ sequence: number }>,
): Promise<void> {
  const channel = {
    ...E2E_CHANNEL,
    messageCount: history.length,
    lastMessageSequence: history.length,
    updatedAt: E2E_NOW,
  };
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  await routeChannelHistoryPages(page, history);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", {
    waitUntil: "domcontentloaded",
  });
}
