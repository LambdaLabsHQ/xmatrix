"use client";
import { decodeChannelSnapshot } from "@xmatrix/protocol";

import { useMemo, useRef, useState } from "react";
import { QueryClient, QueryClientContext } from "@tanstack/react-query";
import type { AgentRegistrationSummary, ChannelMessage, MessageSender, LiveChannel, SerializedSpace } from "@xmatrix/protocol";
import { ChannelSidebar, Composer, MessageTimeline, WorkspaceRail } from "@/components/dashboard/workspace-shell-modules";
import { ChannelHeader } from "@/components/dashboard/workspace-shell-chrome";
import { buildTimeline } from "@/components/dashboard/workspace-shell-recovered";
import { humanProfileFromSpaceMember } from "@/components/dashboard/human-profile-summary";
import type { SpaceChannelCatalog } from "@/components/dashboard/use-channel-catalog-paging";
import type { TimelineJumpHandle } from "@/components/dashboard/workspace-message-timeline";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { useAuth } from "@/lib/auth-context";

/* The real app's rail, conversation list, conversation and composer, fed a
   fixed sample Space instead of the Hub. Nothing here fetches: the preview has
   no token, which every conversation query waits for, and its own query cache
   is seeded with what they read from it: the Space's plan and the agent
   registrations that name each agent's machine. That cache
   is never mounted, so focus and reconnect never refetch it. */

const noop = () => {};
const NO_REBORNING_SENDERS: ReadonlySet<string> = new Set();
const MINUTE = 60_000;

const viewer = { id: "preview-alex", name: "Alex Rivera" };

// Alex is a member, not an owner, so the list shows no owner-only setup prompts.
const space: SerializedSpace = {
  id: "preview-acme",
  name: "Acme",
  ownerId: "preview-maya",
  members: [
    { userId: "preview-maya", email: "maya@acme.dev", name: "Maya Chen", role: "owner", joinedAt: "2026-01-05T09:00:00.000Z" },
    { userId: viewer.id, email: "alex@acme.dev", name: viewer.name, role: "member", joinedAt: "2026-01-05T09:00:00.000Z" },
  ],
  createdAt: "2026-01-05T09:00:00.000Z",
  updatedAt: "2026-01-05T09:00:00.000Z",
};

const agentLogos: Record<string, string> = {
  claude: "/agent-vendors/claude.svg", codex: "/agent-vendors/openai.svg", cursor: "/agent-vendors/cursor.png",
};

/**
 * Which conversation is open: `landing`, a landing page reworked by Claude and
 * Codex, or `launch`, where the three Agents of the homepage's live page are
 * asked for the work that page shows them doing.
 */
export type PreviewScene = "landing" | "launch";

function sender(label: string, kind: MessageSender["kind"]): MessageSender {
  return kind === "agent"
    ? {
        identityId: `agent:${label}`, kind, label, userId: viewer.id, email: "alex@acme.dev", agentName: label,
        avatarUrl: agentLogos[label], instanceId: `preview-${label}-1`,
        registration: { ownerUserId: viewer.id, machineId: "preview-mac-studio", harness: label },
      }
    : { identityId: `user:${viewer.id}`, kind, label, userId: viewer.id, email: "alex@acme.dev" };
}

const alex = sender(viewer.name, "user");
const claude = sender("claude", "agent");
const codex = sender("codex", "agent");
const cursor = sender("cursor", "agent");

/** Each Agent's Instance number in the open conversation. */
const INSTANCE: Record<string, string> = { claude: "1", codex: "2", cursor: "3" };

function agentPresence(label: string, iso: (minutesAgo: number) => string, status: "busy" | "online") {
  return {
    kind: "agent" as const,
    label,
    avatarUrl: agentLogos[label],
    instances: [{
      id: `preview-${label}-1`,
      channelInstanceId: INSTANCE[label] ?? "1",
      label: `${label}:${INSTANCE[label] ?? "1"}`,
      connectedAt: iso(30),
      lastSeenAt: iso(0),
      status,
      hostName: "Mac Studio",
      avatarUrl: agentLogos[label],
    }],
    registration: { ownerUserId: viewer.id, machineId: "preview-mac-studio", harness: label },
  };
}

function sample(now: number, scene: PreviewScene) {
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE).toISOString();
  // Only the open conversation has an agent at work.
  const channel = (id: string, name: string, from: MessageSender, preview: string, minutesAgo: number): LiveChannel => decodeChannelSnapshot({
    id,
    spaceId: space.id,
    name,
    mode: "open",
    messageCount: 4,
    lastMessage: { messageId: `${id}:last`, from, bodyPreview: preview, sentAt: iso(minutesAgo) },
    memberPresence: {
      // Both people are online, so the narrow header's member count agrees with their avatars.
      ...Object.fromEntries(space.members.map((member) => [
        `user:${member.userId}`,
        { kind: "user" as const, label: member.name, email: member.email, status: "online" as const, lastSeenAt: iso(0) },
      ])),
      "agent:claude": agentPresence("claude", iso, "online"),
      "agent:codex": agentPresence("codex", iso, id === "landing" ? "busy" : "online"),
      // Cursor is in the launch conversation alone, still rendering the video.
      ...(id === "launch" ? { "agent:cursor": agentPresence("cursor", iso, "busy") } : {}),
    },
    createdBy: viewer.id,
    createdAt: iso(3 * 24 * 60),
    updatedAt: iso(minutesAgo),
  });

  const channels = [
    ...(scene === "launch" ? [channel("launch", "Launch", cursor, "Rendering the 1080p cut now.", 1)] : []),
    channel("landing", "Landing page refresh", alex, "Looks great. Ship it.", 1),
    channel("billing", "Billing webhook retries", codex, "Retries now back off exponentially.", 5),
    channel("ios", "iOS 2.4 release", alex, "TestFlight build 2.4 (318) is up.", 17),
    channel("onboarding", "Onboarding copy review", claude, "Tightened the three intro sentences.", 40),
    channel("e2e", "Flaky e2e on CI", codex, "Root cause: a race in the socket close.", 94),
    channel("api-docs", "API docs for v2", claude, "Drafted the v2 auth section from the spec.", 180),
  ];

  const open = channels[0]!.id;
  const message = (sequence: number, from: MessageSender, minutesAgo: number, body: string): ChannelMessage => ({
    messageId: `${open}:m${sequence}`,
    channelId: open,
    sequence,
    from,
    body,
    sentAt: iso(minutesAgo),
  });
  const history = scene === "launch" ? [
    message(1, alex, 9, "@claude ship the web editor fix. @codex get build 2.4 into TestFlight. @cursor cut the launch video."),
    message(2, claude, 6, "Merged. The web editor fix is live in `v1.0.464`."),
    message(3, codex, 3, "Build 2.4 is in review, PR #566."),
    message(4, cursor, 1, "Rendering the 1080p cut now."),
  ] : [
    message(1, alex, 12, "@claude rework the hero so it shows the product, not a diagram. @codex check the mobile breakpoints once it lands."),
    message(2, claude, 11, "On it. I'll render the conversation view live instead of a screenshot and keep the copy as is."),
    message(3, codex, 4, "Checked 375, 768 and 1280. Below md it shows only the conversation, so nothing is cropped."),
    message(4, alex, 1, "Looks great. Ship it."),
  ];

  return { channels, history };
}

function registration(harness: string): AgentRegistrationSummary {
  return {
    key: { spaceId: space.id, ownerUserId: viewer.id, machineId: "preview-mac-studio", harness },
    displayName: harness,
    ownerName: viewer.name,
    machineName: "Mac Studio",
    version: 1,
    state: "enabled",
    models: [],
    routingReady: true,
    canManageOwnerGrant: false,
    canConfigureSpace: false,
    canRemoveFromSpace: false,
  };
}

/** `readerId` is whoever is signed in on this browser, which keys the catalog read. */
function previewQueryClient(readerId: string) {
  const client = new QueryClient();
  client.setQueryData(
    xmatrixQueryKeys.domain({ userId: readerId }, "agent-registration-catalog", [space.id]),
    { capabilities: [], registrations: [registration("claude"), registration("codex"), registration("cursor")] },
  );
  return client;
}

export function AppWindowPreview({ scene = "landing" }: { scene?: PreviewScene }) {
  const { user } = useAuth();
  const [queryClient] = useState(() => previewQueryClient(user?.id ?? "anonymous"));
  const { channels, history } = useMemo(() => sample(Date.now(), scene), [scene]);
  const selected = channels[0];
  const timeline = useMemo(
    () => buildTimeline(history, selected, channels, { id: viewer.id, email: "alex@acme.dev", name: viewer.name }, {}, undefined, undefined, undefined, space.members),
    [channels, history, selected],
  );
  const catalog = useMemo<SpaceChannelCatalog>(() => {
    const rows = channels.map((channel) => ({ channel, ownActivityAt: channel.updatedAt }));
    const page = { rows, nextCursor: null, counts: { active: 1, unread: 0, mentions: 0 }, loading: false, loaded: true, error: null };
    return {
      spaceId: space.id,
      page: () => page,
      load: async () => undefined,
      resolve: async () => ({ protocolVersion: 1 as const, channels, pathsByChannelId: {} }),
    };
  }, [channels]);
  const readCounts = useMemo(
    () => Object.fromEntries(channels.map((channel) => [channel.id, channel.messageCount ?? 0])),
    [channels],
  );
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineJumpRef = useRef<TimelineJumpHandle | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  return (
    <QueryClientContext.Provider value={queryClient}>
    <div className="xmatrix-app xmatrix-desktop-macos site-app-window-app flex h-full min-h-0 w-full bg-background text-foreground">
      <WorkspaceRail
        activeView="messages"
        profile={humanProfileFromSpaceMember(viewer, space.members[1])}
        onChangeView={noop}
        onOpenProfile={noop}
        onLogout={noop}
      />
      <div className="app-workspace-panel" style={{ "--app-desktop-sidebar-width": "300px" } as React.CSSProperties}>
        <aside className="app-sidebar hidden w-[var(--app-desktop-sidebar-width)] flex-col bg-sidebar text-sidebar-foreground md:flex">
          <ChannelSidebar
            events={[]}
            spaces={[space]}
            currentSpaceId={space.id}
            selectedChannelId={selected.id}
            loading={false}
            error={null}
            view="messages"
            readCounts={readCounts}
            mentionClearedAt={{}}
            pinState={{ pinnedChannelIds: [], orderedChannelIds: [] }}
            readCountsBaselineReady
            currentUserId={viewer.id}
            renamingSpaceId={null}
            spacesError={null}
            onRenameSpace={noop}
            onManageSpaces={noop}
            onTogglePinned={noop}
            onMarkDone={noop}
            onCopyChannelLink={async () => undefined}
            onSelectSpace={noop}
            onSelect={noop}
            catalogPaging={catalog}
            fallbackChannels={channels}
          />
        </aside>
        <main className="app-main relative flex min-w-0 max-w-full flex-1 flex-col overflow-hidden bg-card/80">
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <section className="app-message-surface relative flex min-w-0 flex-1 flex-col overflow-hidden">
              <ChannelHeader
                channel={selected}
                spaces={[space]}
                currentUserId={viewer.id}
                onRename={noop}
                onVisibilityChange={noop}
                renaming={false}
                updatingVisibility={false}
                onToggleMembers={noop}
                onOpenSearch={noop}
              />
              <MessageTimeline
                channel={selected}
                space={space}
                token={null}
                isJoined
                loading={false}
                timeline={timeline}
                hasWorkDock={false}
                hasChannels
                hasOlderMessages={false}
                olderLoading={false}
                error={null}
                timelineScrollRef={timelineScrollRef}
                timelineJumpRef={timelineJumpRef}
                messagesEndRef={messagesEndRef}
                onScrollPositionChange={noop}
                onScrollGesture={noop}
                onNearTop={noop}
                onOpenAgentTrace={noop}
                onOpenHumanProfile={noop}
                currentUserIdentityId={`user:${viewer.id}`}
                onReact={noop}
                onEdit={noop}
                onRecall={noop}
                onUnsentAction={noop}
                onReply={noop}
                onOpenThread={noop}
                onMentionSender={noop}
                onRebornSender={noop}
                reborningSenderKeys={NO_REBORNING_SENDERS}
                onQuestionnaireAnswer={async () => false}
                onOpenInternalAppLink={() => false}
                onOpenPage={noop}
                onJumpToMessage={noop}
                onMessageExposed={noop}
              />
              <Composer
                channel={selected}
                space={space}
                token={null}
                workspaces={[]}
                isJoined
                draft={scene === "launch" ? "Ship Friday, behind one switch." : "Next up: a dark-mode pass on the same section"}
                draftSeedRevision={1}
                selectedWorkspaceId={null}
                replyTarget={null}
                attachments={[]}
                mentionInsertRequest={null}
                autoFocusRequest={0}
                error={null}
                onDraftChange={noop}
                onWorkspaceSelect={noop}
                onCancelReply={noop}
                onAttachmentsChange={noop}
                onOpenAppsForSpace={noop}
                onSend={noop}
              />
            </section>
          </div>
        </main>
      </div>
    </div>
    </QueryClientContext.Provider>
  );
}
