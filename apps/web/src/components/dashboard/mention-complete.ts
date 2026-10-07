import type {
  AgentInstanceCommandMode,
  AgentInvocationTarget,
  AppConnectorCompletionDynamicSource,
  AppConnectorCompletionOption,
  CommandCompletionArgumentSchema,
  CommandCompletionDelimiter,
  CommandCompletionSchemaNode,
  InteractionTargetDescriptor,
  MessageInteractionRegistry,
  SerializedAgent,
  SerializedAgentInstance,
  SerializedChannel,
  SerializedMachineDaemon,
  SerializedSpace,
} from "@xmatrix/protocol";
import { harnessParameterValueLabel, isLiveAgentStatus } from "@xmatrix/protocol";
import {
  agentInteractionTarget,
  connectorInteractionTarget,
  humanInteractionTarget,
  interactionRegistry,
} from "@xmatrix/protocol";
import {
  AGENT_HANDOFF_ACTION_COMPLETION_SCHEMA,
  AGENT_INSTANCE_COMMAND_COMPLETION_SCHEMA,
  MENTION_COMMAND_COMPLETION_SCHEMA,
  MENTION_BROADCAST_NAMES,
  canonicalMentionToken,
  agentAvatarUrlFromMetadata,
  HANDOFF_INSTANCE_MENTION_AT_CARET_RE,
  isHandoffSuccessorName,
} from "@xmatrix/protocol";
import {
  spaceMemberForChannelIdentity,
  visibleHumanChannelMemberIds,
} from "./channel-human-members";

export type MentionAppConnector = {
  id: string;
  name: string;
  status?: "available" | "planned";
  actions?: Array<{
    id: string;
    label: string;
    description?: string;
    completion?: {
      trailingDelimiter?: CommandCompletionDelimiter;
      arguments?: CommandCompletionArgumentSchema;
    };
  }>;
};

export type MentionCandidate = {
  launchTags?: import("@xmatrix/protocol").AutoLaunchTags;
  launchField?: import("@xmatrix/protocol").AutoLaunchField;
  invocationTarget?: AgentInvocationTarget;
  id: string;
  name: string;
  kind: "agent" | "user" | "app" | "service" | "launch";
  status: SerializedAgent["status"];
  email?: string;
  avatarUrl?: string;
  agentId?: string;
  /** Existing alternate Human address, retained for compatibility. */
  handle?: string;
  mention?: string;
  local?: boolean;
  action?:
    | "agent-goal-clear"
    | "agent-goal-pause"
    | "agent-goal-replace"
    | "agent-goal-resume"
    | "agent-goal-set"
    | "agent-goal-status"
    | "agent-model-switch"
    | "agent-effort-switch"
    | "handoff-instance"
    | "app-command";
  appId?: string;
  appActionId?: string;
  description?: string;
  /** Shown, but not selectable. The text is why, for example "Offline". */
  unavailable?: string;
  completionSuffix?: CommandCompletionDelimiter;
  schemaNodeId?: string;
};

export type MentionCompletionStage =
  | "target"
  | "agent-reference"
  | "handoff-successor"
  | "agent-command"
  | "agent-model"
  | "agent-effort"
  | "agent-goal"
  | "app-action"
  | "app-argument"
  | "argument";

export type MentionDynamicCompletionRequest = {
  cacheKey: string;
  providerId: string;
  source: AppConnectorCompletionDynamicSource;
  parent?: string;
};

export type MentionDynamicCompletionValues = Record<string, AppConnectorCompletionOption[]>;

export type MentionCompletionResult = {
  active: ActiveMention | null;
  candidates: MentionCandidate[];
  stage: MentionCompletionStage;
  stageLabel: string;
  dynamicRequest?: MentionDynamicCompletionRequest;

};

export type MentionCandidateSection = {
  kind: MentionCandidate["kind"];
  label: "Condition" | "AI service" | "Agent" | "Human" | "App";
  candidates: MentionCandidate[];
  startIndex: number;
  totalCount: number;
  hiddenCount: number;
  expanded: boolean;
};

export type MentionCandidateSectionOptions = {
  limitPerKind?: number;
  /** Kinds the human opened by hand, which show every candidate they have. */
  expandedKinds?: Iterable<MentionCandidate["kind"]>;
  /**
   * Kinds that start open at `limitPerKind` rows. Every other kind folds to no
   * rows at all until it is expanded. Omit it and every kind starts open, which
   * is what the non-browsing stages want.
   */
  openKinds?: Iterable<MentionCandidate["kind"]>;
};

export type ActiveMention = {
  start: number;
  /** The caret, which is where the typed query ends. */
  end: number;
  /**
   * End of the whole mention token, which is past the caret whenever the human
   * typed `@` in front of text that was already there. Completion replaces up
   * to here, never only to the caret: leaving the tail behind produced drafts
   * with a duplicated target name, which no longer address the intended Agent.
   */
  tokenEnd: number;
  query: string;
};

export type ParsedAppMention = {
  token: string;
  appId: string;
  appName: string;
  status: "available" | "planned";
  actionId?: string;
  actionLabel?: string;
};

export type MentionLocalContext = {
  machineId?: string | null;
  hostId?: string | null;
  hostName?: string | null;
};

export type MentionDesktopContext = {
  machineId?: string | null;
  hostId?: string | null;
  hostName?: string | null;
};

type MentionSpace = Pick<SerializedSpace, "id" | "members">;

const MENTION_QUERY_RE = /(?:^|\s)@(\S*)$/;
const COMPOSABLE_AGENT_MENTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/;
const AGENT_COMMAND_QUERY_RE = /^\S+\s+\/.*$/;

function agentRegistryAvatarUrl(agent: SerializedAgent | undefined): string | undefined {
  if (!agent) return undefined;
  return agent.avatarUrl || agentAvatarUrlFromMetadata(agent.metadata, agent.type);
}

export function connectorCompletionErrorMessage(message: string): string {
  switch (message) {
    case "App connection not found":
      return "Connect GitHub to this space before loading repositories.";
    case "App connection is not configured":
      return "GitHub needs attention in Apps before repositories can be loaded.";
    case "Channel not found":
      return "This channel is not available for GitHub completion.";
    case "github_app_not_configured":
    case "github_installation_missing":
      return "The GitHub App connection is incomplete. Reconnect it in Apps.";
    default:
      if (message.startsWith("github_api_")) {
        return "GitHub did not return the installation repositories. Check GitHub access and retry.";
      }
      return "Could not load GitHub completion options. Retry or check the connector configuration.";
  }
}

export type ConnectorCompletionRecovery = "configure" | "retry" | null;

export function connectorCompletionRecovery(message: string): ConnectorCompletionRecovery {
  switch (message) {
    case "App connection not found":
    case "App connection is not configured":
    case "github_app_not_configured":
    case "github_installation_missing":
      return "configure";
    case "Channel not found":
      return null;
    default:
      return "retry";
  }
}

/**
 * The Agents of this Channel, one per Agent member. Every member is a
 * registration Run keyed by its Instance, and its registration is its only
 * identity: owner, machine and harness come from there, never from a separate
 * Agent record.
 */
export function channelAgents(channel: SerializedChannel): SerializedAgent[] {
  const agents: SerializedAgent[] = [];
  for (const [memberId, presence] of Object.entries(channel.memberPresence || {})) {
    if (presence.kind !== "agent") continue;
    const name = presence.label?.trim();
    const instances = presence.instances || [];
    if (!name) continue;
    const lead = [...instances].sort(
      (left, right) => mentionStatusRank(left.status) - mentionStatusRank(right.status)
    )[0];
    agents.push({
      id: memberId,
      userId: presence.registration?.ownerUserId || "",
      name,
      type: presence.registration?.harness || "",
      lifetime: "short",
      email: presence.email || "",
      metadata: presence.registration ? { machineId: presence.registration.machineId } : {},
      connectedAt: lead?.connectedAt || "",
      lastSeenAt: presence.lastSeenAt || lead?.lastSeenAt || "",
      status: lead?.status || "offline",
      ...(presence.avatarUrl ? { avatarUrl: presence.avatarUrl } : {}),
      instances,
    });
  }
  return agents;
}

export function localMentionContextFromDaemon(
  daemons: SerializedMachineDaemon[],
  desktopContext: MentionDesktopContext | null
): MentionLocalContext | null {
  const desktopKeys = normalizedMachineKeys([
    desktopContext?.machineId || "",
  ]);
  if (desktopKeys.length === 0) return null;

  const daemon =
    daemons.find((candidate) =>
      candidate.status === "online" && daemonMatchesLocalMachine(candidate, desktopKeys)
    ) ||
    daemons.find((candidate) => daemonMatchesLocalMachine(candidate, desktopKeys));
  if (!daemon) return null;

  return {
    machineId:
      desktopContext?.machineId?.trim() ||
      daemon.machineId ||
      metadataString(daemon.metadata, "machineId") ||
      undefined,
    hostId:
      daemon.hostId ||
      metadataString(daemon.metadata, "hostId") ||
      desktopContext?.hostId ||
      undefined,
    hostName:
      daemon.hostName ||
      metadataString(daemon.metadata, "hostName") ||
      metadataString(daemon.metadata, "hostname") ||
      desktopContext?.hostName ||
      undefined,
  };
}

/**
 * A stable Agent identity has no live status: only its concrete channel-local
 * instances do. Agent-level mention candidates therefore always use this
 * neutral value so an instance that is busy in another channel or thread can
 * never leak an agent-level "busy" into a fresh channel's completion list.
 */
const AGENT_IDENTITY_NEUTRAL_STATUS: SerializedAgent["status"] = "offline";

/**
 * Which live instances a composer may address. An instance belongs to exactly
 * one Channel, so a composer that has no Channel of its own yet — the inline
 * Reply-in-thread draft, whose thread Channel is created only when the first
 * reply is sent — has nothing to address. It renders against the parent Channel
 * purely so that abandoning the draft leaves no empty thread behind; offering
 * the parent's instances there would advertise targets that do not exist at the
 * destination, and Authority answers such a mention with "could not find" or with
 * silence. "none" keeps that composer at registration level: start a new
 * instance in the thread, which is the only thing a thread can actually have.
 */
export type MentionInstanceTargetScope = "channel" | "none";

/**
 * The conversation's addresses as interaction targets: each candidate the
 * composer offers is the display of one descriptor the registry accepted, so
 * a reserved or malformed name never becomes a suggestion and the operations
 * offered are the ones the grammar knows.
 */
export function channelInteractionTargets(
  channel: SerializedChannel | null,
  localContext?: MentionLocalContext | null,
  appConnectors: MentionAppConnector[] = [],
  space?: MentionSpace | null,
  instanceTargetScope: MentionInstanceTargetScope = "channel",
): { registry: MessageInteractionRegistry; candidates: MentionCandidate[] } {
  const entries = channel ? channelTargetEntries(channel, localContext, appConnectors, space, instanceTargetScope) : [];
  const registry = interactionRegistry(entries.map(entry => entry.descriptor));
  const accepted = new Set(registry.descriptors().map(descriptor => descriptor.targetId));
  return { registry, candidates: entries.filter(entry => accepted.has(entry.descriptor.targetId)).map(entry => entry.candidate) };
}

export function channelMentionCandidates(
  channel: SerializedChannel | null,
  localContext?: MentionLocalContext | null,
  appConnectors: MentionAppConnector[] = [],
  space?: MentionSpace | null,
  instanceTargetScope: MentionInstanceTargetScope = "channel",
): MentionCandidate[] {
  return channelInteractionTargets(channel, localContext, appConnectors, space, instanceTargetScope).candidates;
}

type TargetEntry = { descriptor: InteractionTargetDescriptor; candidate: MentionCandidate };

function channelTargetEntries(
  channel: SerializedChannel,
  localContext: MentionLocalContext | null | undefined,
  appConnectors: MentionAppConnector[],
  space: MentionSpace | null | undefined,
  instanceTargetScope: MentionInstanceTargetScope,
): TargetEntry[] {

  const localMachineKeys = mentionLocalMachineKeys(localContext);
  const seen = new Set<string>();
  const seenAgentNames = new Set<string>();
  const candidates: TargetEntry[] = [];

  function addCandidate(candidate: MentionCandidate, descriptor: InteractionTargetDescriptor) {
    if (seen.has(candidate.id)) return;
    seen.add(candidate.id);
    candidates.push({ candidate, descriptor });
  }

  function addAgentNameCandidate(candidate: MentionCandidate, descriptor: InteractionTargetDescriptor) {
    const nameKey = mentionToken(candidate.mention || candidate.name);
    if (!nameKey || seenAgentNames.has(nameKey)) return;
    seenAgentNames.add(nameKey);
    addCandidate(candidate, descriptor);
  }

  const agentTargetDescription = instanceTargetScope === "none"
    ? "Agent reference"
    : "Choose a channel instance";
  for (const memberId of visibleHumanChannelMemberIds(channel, space)) {
    const directoryMember = spaceMemberForChannelIdentity(space, memberId);
    if (!directoryMember) continue;
    const memberPresence = channel.memberPresence?.[memberId];
    const humanPresence = memberPresence?.kind === "user" ? memberPresence : undefined;
    const handle = directoryMember.handle?.trim();
    const name = directoryMember.name?.trim() || handle;
    if (!name) continue;
    // Broadcast words must never be inserted as an individual person's name.
    const mention = MENTION_BROADCAST_NAMES.includes(canonicalMentionToken(name)) || canonicalMentionToken(name) === "auto"
      ? handle : name;
    if (!mention) continue;
    if (canonicalMentionToken(mention) === "auto") continue;
    addCandidate({
      id: memberId,
      name,
      kind: "user",
      status: humanPresence?.status || "offline",
      email: directoryMember.email,
      avatarUrl: directoryMember.avatarUrl,
      ...(handle ? { handle } : {}),
      mention,
      completionSuffix: " ",
    }, humanInteractionTarget(memberId, [mention, ...(handle ? [handle] : [])]));
  }

  for (const agent of channelAgents(channel)) {
    if (seen.has(agent.id)) continue;
    const mention = agent.name;
    // `@auto` is the routing keyword; a member of that name is addressed by slot.
    if (!COMPOSABLE_AGENT_MENTION_NAME_RE.test(mention) || canonicalMentionToken(mention) === "auto") continue;
    addAgentNameCandidate({
      id: agent.id,
      name: agent.name,
      kind: "agent",
      status: AGENT_IDENTITY_NEUTRAL_STATUS,
      email: agent.email,
      avatarUrl: agentRegistryAvatarUrl(agent),
      mention,
      local: isLocalAgentCandidate(localMachineKeys, agent),
      description: agentTargetDescription,
      completionSuffix: ":",
    }, agentInteractionTarget(agent.id, mention));
  }

  for (const app of appConnectors) {
    const appMention = mentionToken(app.id || app.name);
    addCandidate({
      id: `app:${app.id}`,
      name: app.name,
      kind: "app",
      status: app.status === "available" ? "online" : "offline",
      mention: appMention,
      appId: app.id,
      description: app.status === "available" ? "App connector" : "Planned app connector",
      completionSuffix: ":",
    }, connectorInteractionTarget(appMention, (app.actions ?? []).map(action => action.id)));
  }

  return candidates.sort(({ candidate: left }, { candidate: right }) => {
    if (left.kind === "app" || right.kind === "app") {
      if (left.kind !== right.kind) return left.kind === "app" ? 1 : -1;
      return left.name.localeCompare(right.name);
    }
    const leftLocal = mentionLocalRank(left);
    const rightLocal = mentionLocalRank(right);
    if (leftLocal !== rightLocal) return leftLocal - rightLocal;
    const leftOnline = mentionStatusRank(left.status);
    const rightOnline = mentionStatusRank(right.status);
    if (leftOnline !== rightOnline) return leftOnline - rightOnline;
    if (left.kind !== right.kind) return left.kind === "agent" ? -1 : 1;
    const nameOrder = left.name.localeCompare(right.name);
    if (nameOrder !== 0) return nameOrder;
    return 0;
  });
}

export function resolveMentionCompletion(
  draft: string,
  cursor: number,
  channel: SerializedChannel | null,
  localContext?: MentionLocalContext | null,
  appConnectors: MentionAppConnector[] = [],
  space?: MentionSpace | null,
  dynamicValues: MentionDynamicCompletionValues = {},
  instanceTargetScope: MentionInstanceTargetScope = "channel",
  successorHarnesses: readonly string[] = [],
): MentionCompletionResult {
  const active = findActiveMention(draft, cursor);
  if (!active || !channel) {
    return {
      active,
      candidates: [],
      stage: "target",
      stageLabel: MENTION_COMMAND_COMPLETION_SCHEMA.label,
    };
  }

  const agents = channelAgents(channel);
  const commandMatch = active.query.match(/^(\S+)\s+\/(.*)$/);
  if (commandMatch) {
    return resolveAgentCommandCompletion(
      active,
      commandMatch[1],
      commandMatch[2],
      channel,
      agents,
      localContext,
      instanceTargetScope
    );
  }

  const colonIndex = active.query.indexOf(":");
  if (colonIndex >= 0) {
    const targetToken = active.query.slice(0, colonIndex);
    const segmentQuery = active.query.slice(colonIndex + 1);
    const app = appConnectors.find((candidate) => mentionToken(candidate.id || candidate.name) === mentionToken(targetToken));
    if (app) {
      const appMention = mentionToken(app.id || app.name);
      const actionSeparatorIndex = segmentQuery.indexOf(":");
      if (actionSeparatorIndex >= 0) {
        const actionToken = segmentQuery.slice(0, actionSeparatorIndex);
        const action = (app.actions || []).find(
          (candidate) => mentionToken(candidate.id) === mentionToken(actionToken)
        );
        const argumentSchema = action?.completion?.arguments;
        if (!action || !argumentSchema) {
          return {
            active,
            candidates: [],
            stage: "argument",
            stageLabel: `${app.name} arguments`,
          };
        }
        return resolveAppArgumentCompletion({
          active,
          app,
          appMention,
          actionId: mentionToken(action.id),
          argumentTail: segmentQuery.slice(actionSeparatorIndex + 1),
          schema: argumentSchema,
          dynamicValues,
          spaceId: space?.id,
          channelId: channel.id,
        });
      }
      // Only operations the connector's descriptor declares are offered.
      const { registry } = channelInteractionTargets(channel, localContext, [app], space, instanceTargetScope);
      const declared = (app.actions || []).filter((action) =>
        registry.resolve(appMention, action.id.trim().toLowerCase()).status === "resolved");
      const candidates = declared.map<MentionCandidate>((action) => ({
        id: `app:${app.id}:${action.id}`,
        name: action.label,
        kind: "app",
        status: app.status === "available" ? "online" : "offline",
        mention: `${appMention}:${mentionToken(action.id)}`,
        action: "app-command",
        appId: app.id,
        appActionId: action.id,
        description: action.description,
        completionSuffix: action.completion?.trailingDelimiter || " ",
        schemaNodeId: `connector:${app.id}:${action.id}`,
      }));
      return {
        active,
        candidates: filterMentionCandidates(candidates, segmentQuery),
        stage: "app-action",
        stageLabel: `${app.name} actions`,
      };
    }

    const ordinal = /^([1-9]\d*)(?=:|$)/u.exec(segmentQuery)?.[1];
    const addressedInstance = ordinal ? findAgentInstanceTarget(channel, agents,
      `${targetToken}:${ordinal}`, instanceTargetScope) : undefined;
    const agent = addressedInstance?.agent ?? findMentionAgent(agents, targetToken, localContext);
    if (agent) {
      const handoffSuccessor = handoffSuccessorQuery(active.query);
      if (handoffSuccessor) {
        return resolveHandoffSuccessorCompletion(
          active,
          agent,
          channel,
          successorHarnesses,
          handoffSuccessor.channelInstanceId,
          handoffSuccessor.successorQuery,
          instanceTargetScope,
        );
      }
      const candidates = agentReferenceCandidates(channel, agent, agents, localContext, instanceTargetScope,
        agent.name);
      return {
        active,
        candidates: filterMentionCandidates(candidates, segmentQuery),
        stage: "agent-reference",
        stageLabel: `${agent.name} target`,
      };
    }
  }

  const rootCandidates = channelMentionCandidates(
    channel,
    localContext,
    appConnectors,
    space,
    instanceTargetScope,
  );
  return {
    active,
    candidates: filterMentionCandidates(rootCandidates, active.query),
    stage: "target",
    stageLabel: MENTION_COMMAND_COMPLETION_SCHEMA.label,
  };
}

function handoffSuccessorQuery(
  mentionQuery: string,
): { channelInstanceId: string; successorQuery: string } | undefined {
  const parsed = HANDOFF_INSTANCE_MENTION_AT_CARET_RE.exec(`@${mentionQuery}`);
  if (!parsed) return undefined;
  return { channelInstanceId: parsed[1]!, successorQuery: parsed[2] || "" };
}

/**
 * A handoff starts a new Run of a harness the Space has registered; the router
 * picks its location, so successors are harnesses, not particular Agents.
 */
function resolveHandoffSuccessorCompletion(
  active: ActiveMention,
  sourceAgent: SerializedAgent,
  channel: SerializedChannel,
  successorHarnesses: readonly string[],
  channelInstanceId: string,
  successorQuery: string,
  instanceTargetScope: MentionInstanceTargetScope = "channel",
): MentionCompletionResult {
  const sourceInstance = channelAgentInstances(channel, sourceAgent, instanceTargetScope)
    .find((instance) => instance.channelInstanceId?.trim() === channelInstanceId);
  const sourceMention = sourceInstance
    ? agentInstanceMentionLabel(sourceAgent.name, sourceInstance)
    : `${sourceAgent.name}:${channelInstanceId}`;
  const harnesses = [...new Set(successorHarnesses.map(mentionToken))]
    .filter((harness) => harness && isHandoffSuccessorName(harness));
  const candidates = harnesses.map<MentionCandidate>((harness) => ({
    id: `${sourceAgent.id}:${channelInstanceId}:handoff:${harness}`,
    name: harness,
    kind: "agent",
    status: AGENT_IDENTITY_NEUTRAL_STATUS,
    avatarUrl: agentAvatarUrlFromMetadata({}, harness),
    mention: `${sourceMention}:handoff:@${harness}`,
    action: "handoff-instance",
    description: `Hand off @${sourceMention} to a new @${harness} instance`,
    completionSuffix: " ",
    schemaNodeId: "handoff-successor-profiles",
  }));
  return {
    active,
    candidates: filterMentionCandidates(candidates, successorQuery),
    stage: "handoff-successor",
    stageLabel: `Hand off @${sourceMention}`,
  };
}

function resolveAppArgumentCompletion(input: {
  active: ActiveMention;
  app: MentionAppConnector;
  appMention: string;
  actionId: string;
  argumentTail: string;
  schema: CommandCompletionArgumentSchema;
  dynamicValues: MentionDynamicCompletionValues;
  spaceId?: string;
  channelId: string;
  parent?: string;
  prefix?: string;
}): MentionCompletionResult {
  const prefix = input.prefix || "";
  const nextDelimiterIndex = input.schema.next
    ? input.argumentTail.indexOf(input.schema.trailingDelimiter)
    : -1;
  if (input.schema.next && nextDelimiterIndex >= 0) {
    const selected = input.argumentTail.slice(0, nextDelimiterIndex).trim();
    if (!selected) {
      return {
        active: input.active,
        candidates: [],
        stage: "app-argument",
        stageLabel: input.schema.label,
      };
    }
    return resolveAppArgumentCompletion({
      ...input,
      argumentTail: input.argumentTail.slice(nextDelimiterIndex + input.schema.trailingDelimiter.length),
      schema: input.schema.next,
      parent: selected,
      prefix: `${prefix}${selected}${input.schema.trailingDelimiter}`,
    });
  }

  if (!input.schema.next && input.argumentTail.includes(input.schema.trailingDelimiter)) {
    return {
      active: input.active,
      candidates: [],
      stage: "argument",
      stageLabel: `${input.app.name} arguments`,
    };
  }

  const cacheKey = appCompletionCacheKey(
    input.spaceId,
    input.channelId,
    input.app.id,
    input.schema.source,
    input.parent
  );
  const options = input.dynamicValues[cacheKey] || [];
  const candidates = options.map<MentionCandidate>((option) => ({
    id: `app:${input.app.id}:${input.actionId}:${input.schema.id}:${option.id}`,
    name: option.label,
    kind: "app",
    status: input.app.status === "available" ? "online" : "offline",
    mention: `${input.appMention}:${input.actionId}:${prefix}${option.value}`,
    action: "app-command",
    appId: input.app.id,
    appActionId: input.actionId,
    description: option.description,
    completionSuffix: input.schema.trailingDelimiter,
    schemaNodeId: input.schema.id,
  }));
  return {
    active: input.active,
    candidates: filterMentionCandidates(candidates, input.argumentTail),
    stage: "app-argument",
    stageLabel: input.schema.label,
    dynamicRequest: input.spaceId
      ? {
          cacheKey,
          providerId: input.app.id,
          source: input.schema.source,
          parent: input.parent,
        }
      : undefined,
  };
}

export function appCompletionCacheKey(
  spaceId: string | undefined,
  channelId: string,
  providerId: string,
  source: AppConnectorCompletionDynamicSource,
  parent?: string
): string {
  return [spaceId || "", channelId, providerId, source, parent?.toLowerCase() || ""].join(":");
}

type AdvertisedInstanceCommand = {
  token: string;
  label: string;
  description?: string;
  mode?: AgentInstanceCommandMode;
  argumentSource?: "agent-models" | "agent-efforts";
  freeform?: boolean;
};

/** The runtime-advertised `/…` commands of one live instance, normalized. */
export function advertisedInstanceCommands(
  instance: SerializedAgentInstance
): AdvertisedInstanceCommand[] {
  const commands = (instance.commands || [])
    .map((command) => ({
      token: command.token?.trim() || "",
      label: command.label?.trim() || command.token?.trim() || "",
      description: command.description,
      mode: command.mode,
      argumentSource: command.argumentSource,
      freeform: command.freeform,
    }))
    .filter((command) => command.token.startsWith("/"))
    .filter(command => instance.parameters === undefined || command.token !== "/fast" || instance.parameters.some(p => p.id === "fast"));
  if (instance.parameters?.length && !commands.some(c => c.token === "/config")) {
    commands.push({ token: "/config", label: "Configure harness", description: "Choose a parameter reported by this runtime.",
      mode: "typed", argumentSource: undefined, freeform: true });
  }
  if (instance.parameters?.some(p => p.id === "fast") && !commands.some(c => c.token === "/fast")) {
    commands.push({ token: "/fast", label: "Fast mode", description: "Select the runtime's Fast mode.", mode: "typed", argumentSource: undefined, freeform: true });
  }
  return commands;
}

/**
 * One command a live instance can be given, independent of how the human
 * reached it. `@instance /` lists these after a target is already chosen, and
 * the slash-first palette lists their union before one is — both must agree on
 * what an instance actually accepts, so both read this.
 */
export type InstanceCommandOption = {
  /** Stable per-instance id for the row, not the wire token. */
  id: string;
  /** Command token including the leading slash, e.g. `/effort`. */
  token: string;
  label: string;
  description?: string;
  action?: MentionCandidate["action"];
  schemaNodeId: string;
};

/**
 * The effective command set of one live instance: what its runtime advertises,
 * or — for runtimes that predate command advertising — the built-in schema
 * narrowed to the controls this instance actually reported support for.
 */
export function instanceCommandOptions(
  agent: SerializedAgent,
  instance: SerializedAgentInstance
): InstanceCommandOption[] {
  const advertised = advertisedInstanceCommands(instance);
  if (advertised.length > 0) {
    return advertised.map((command) => {
      const isTypedGoal =
        command.mode === "typed" && command.token.toLowerCase() === "/goal";
      return {
        id: `command-${command.token}`,
        token: command.token,
        // `/goal` opens both the freeform set path and the goal-control
        // palette. Calling this row "Set goal" makes the controls look like
        // required choices even though typing the objective is the set action.
        label: isTypedGoal ? "Goal" : command.label || command.token,
        description: isTypedGoal
          ? "Type a new goal or choose a goal control command."
          : command.description,
        action:
          command.mode === "typed" && command.argumentSource === "agent-models"
            ? ("agent-model-switch" as const)
            : command.mode === "typed" && command.argumentSource === "agent-efforts"
              ? ("agent-effort-switch" as const)
              : isTypedGoal
                ? ("agent-goal-set" as const)
                : undefined,
        schemaNodeId: `runtime:${command.token}`,
      };
    });
  }
  return AGENT_INSTANCE_COMMAND_COMPLETION_SCHEMA.filter((node) => {
    if (node.id === "model") return (instance.models || []).length > 0;
    if (node.id === "effort") return instanceEffortOptions(instance).length > 0;
    return node.id !== "goal" || agentSupportsGoalCommand(agent, instance);
  }).map((node) => ({
    id: node.id,
    token: node.token,
    label: node.label,
    description: node.description,
    action: mentionCandidateAction(node.action),
    schemaNodeId: node.id,
  }));
}

function resolveAgentCommandCompletion(
  active: ActiveMention,
  targetToken: string,
  commandTail: string,
  channel: SerializedChannel,
  agents: SerializedAgent[],
  localContext?: MentionLocalContext | null,
  instanceTargetScope: MentionInstanceTargetScope = "channel"
): MentionCompletionResult {
  const target = findAgentInstanceTarget(channel, agents, targetToken, instanceTargetScope);
  if (!target) {
    return { active, candidates: [], stage: "agent-command", stageLabel: "Agent commands" };
  }
  const candidateBase = {
    kind: "agent" as const,
    status: target.instance.status,
    email: target.agent.email,
    local: isLocalAgentCandidate(mentionLocalMachineKeys(localContext), target.agent, target.instance),
  };

  const advertisedCommands = advertisedInstanceCommands(target.instance);

  const argumentIndex = commandTail.indexOf(" ");
  if (argumentIndex < 0) {
    const candidates = instanceCommandOptions(target.agent, target.instance).map((option) => ({
      ...candidateBase,
      id: `${target.agent.id}:${target.instance.id}:command-${option.id}`,
      name: option.label,
      mention: `${target.mention} ${option.token}`,
      description: option.description,
      action: option.action,
      completionSuffix: " " as const,
      schemaNodeId: option.schemaNodeId,
    }));
    return {
      active,
      candidates: filterMentionCandidates(candidates, commandTail),
      stage: "agent-command",
      stageLabel: `@${target.mention} commands`,
    };
  }

  const commandToken = commandTail.slice(0, argumentIndex).toLowerCase();
  const argumentQuery = commandTail.slice(argumentIndex + 1);
  if (commandToken === "config" || commandToken === "fast") {
    const parameters = target.instance.parameters ?? [];
    const split = argumentQuery.indexOf(" ");
    const id = commandToken === "fast" ? "fast" : split < 0 ? undefined : argumentQuery.slice(0, split);
    const query = commandToken === "fast" ? argumentQuery : split < 0 ? argumentQuery : argumentQuery.slice(split + 1);
    const parameter = parameters.find(p => p.id === id);
    const candidates: MentionCandidate[] = id === undefined ? parameters.map(p => ({
      ...candidateBase, id: `${target.instance.id}:parameter:${p.id}`, name: p.label,
      mention: `${target.mention} /config ${p.id}`,
      description: [p.currentValue && harnessParameterValueLabel(p, p.currentValue), p.notice, p.description]
        .filter(Boolean).join(" · ") || undefined,
      completionSuffix: " " as const,
    })) : (parameter?.options ?? []).map(value => ({
      ...candidateBase, id: `${target.instance.id}:parameter:${id}:${value}`,
      name: parameter ? harnessParameterValueLabel(parameter, value) : value,
      description: [value === parameter?.currentValue ? "Current" : undefined,
        parameter?.choices?.find(choice => choice.value === value)?.description].filter(Boolean).join(" · ") || undefined,
      mention: commandToken === "fast" ? `${target.mention} /fast ${value}` : `${target.mention} /config ${id} ${value}`,
    }));
    return { active, candidates: filterMentionCandidates(candidates, query), stage: "argument",
      stageLabel: parameter?.label ?? "Harness parameters" };
  }

  const advertised = advertisedCommands.find(
    (command) => command.token.replace(/^\//, "").toLowerCase() === commandToken
  );
  const commandNode =
    AGENT_INSTANCE_COMMAND_COMPLETION_SCHEMA.find(
      (node) => node.token.replace(/^\//, "").toLowerCase() === commandToken
    ) ||
    (advertised
      ? {
          id: advertised.token.replace(/^\//, ""),
          token: advertised.token,
          label: advertised.label,
          description: advertised.description,
          next: advertised.argumentSource
            ? { delimiter: " " as const, source: advertised.argumentSource }
            : advertised.freeform
              ? { delimiter: " " as const, freeform: true }
              : undefined,
        }
      : undefined);
  if (!commandNode) {
    return { active, candidates: [], stage: "argument", stageLabel: "Command arguments" };
  }

  const argumentSource =
    advertised?.argumentSource ||
    commandNode.next?.source ||
    undefined;

  if (argumentSource === "agent-models") {
    if (argumentQuery.includes(" ")) {
      return { active, candidates: [], stage: "argument", stageLabel: "Model selected" };
    }
    const token = commandNode.token.startsWith("/") ? commandNode.token : `/${commandNode.token}`;
    const candidates = (target.instance.models || []).flatMap<MentionCandidate>((model) => {
      const modelName = model.model?.trim();
      if (!modelName) return [];
      const selected =
        modelName.toLowerCase() === target.instance.model?.trim().toLowerCase() ||
        model.id?.trim().toLowerCase() === target.instance.model?.trim().toLowerCase();
      return [{
        ...candidateBase,
        id: `${target.agent.id}:${target.instance.id}:model-${model.id || modelName}`,
        name: model.displayName?.trim() || modelName,
        mention: `${target.mention} ${token} ${modelName}`,
        action: "agent-model-switch",
        description: selected ? "Current model" : `Switch to ${modelName}`,
        completionSuffix: " " as const,
        schemaNodeId: `${commandNode.id}:${model.id || modelName}`,
      }];
    });
    return {
      active,
      candidates: filterMentionCandidates(candidates, argumentQuery),
      stage: "agent-model",
      stageLabel: `@${target.mention} models`,
    };
  }

  if (argumentSource === "agent-efforts") {
    if (argumentQuery.includes(" ")) {
      return { active, candidates: [], stage: "argument", stageLabel: "Effort selected" };
    }
    const token = commandNode.token.startsWith("/") ? commandNode.token : `/${commandNode.token}`;
    const candidates = instanceEffortOptions(target.instance).map<MentionCandidate>((option) => {
      const selected =
        option.effort.toLowerCase() === target.instance.effort?.trim().toLowerCase();
      return {
        ...candidateBase,
        id: `${target.agent.id}:${target.instance.id}:effort-${option.effort}`,
        name: option.effort,
        mention: `${target.mention} ${token} ${option.effort}`,
        action: "agent-effort-switch",
        description: selected
          ? "Current effort"
          : option.description || `Switch to ${option.effort}`,
        completionSuffix: " " as const,
        schemaNodeId: `${commandNode.id}:${option.effort}`,
      };
    });
    return {
      active,
      candidates: filterMentionCandidates(candidates, argumentQuery),
      stage: "agent-effort",
      stageLabel: `@${target.mention} efforts`,
    };
  }

  if (commandNode.id === "goal" || commandToken === "goal") {
    if (argumentQuery.includes(" ")) {
      return { active, candidates: [], stage: "argument", stageLabel: "Goal text" };
    }
    const candidates = (commandNode.next?.nodes || [])
      .filter((node) => agentSupportsGoalControl(target.instance, node.id))
      .map((node) => schemaNodeCandidate(node, {
        ...candidateBase,
        id: `${target.agent.id}:${target.instance.id}:goal-${node.id}`,
        mention: `${target.mention} ${commandNode.token} ${node.token}`,
      }));
    return {
      active,
      candidates: filterMentionCandidates(candidates, argumentQuery),
      stage: "agent-goal",
      stageLabel: "Type a new goal, or choose an action below",
    };
  }

  return { active, candidates: [], stage: "argument", stageLabel: "Command arguments" };
}

function schemaNodeCandidate(
  node: CommandCompletionSchemaNode,
  base: Pick<MentionCandidate, "id" | "kind" | "mention" | "status" | "email" | "local">
): MentionCandidate {
  return {
    ...base,
    name: node.label,
    action: mentionCandidateAction(node.action),
    description: node.description,
    completionSuffix: node.next?.delimiter || node.trailingDelimiter || " ",
    schemaNodeId: node.id,
  };
}

function mentionCandidateAction(action: string | undefined): MentionCandidate["action"] {
  if (
    action === "agent-goal-clear" ||
    action === "agent-goal-pause" ||
    action === "agent-goal-replace" ||
    action === "agent-goal-resume" ||
    action === "agent-goal-set" ||
    action === "agent-goal-status" ||
    action === "agent-model-switch" ||
    action === "agent-effort-switch" ||
    action === "handoff-instance" ||
    action === "app-command"
  ) {
    return action;
  }
  return undefined;
}

export function instanceEffortOptions(
  instance: SerializedAgentInstance
): Array<{ effort: string; description?: string }> {
  const models = instance.models || [];
  const currentModel = instance.model?.trim().toLowerCase();
  const scoped =
    (currentModel
      ? models.find(
          (item) =>
            item.model?.trim().toLowerCase() === currentModel ||
            item.id?.trim().toLowerCase() === currentModel
        )
      : undefined) ||
    models.find((item) => item.isDefault) ||
    models[0];
  const sourceModels = scoped ? [scoped] : models;
  const seen = new Set<string>();
  const options: Array<{ effort: string; description?: string }> = [];
  for (const model of sourceModels) {
    for (const entry of model.supportedReasoningEfforts || []) {
      const effort = entry.reasoningEffort?.trim();
      if (!effort) continue;
      const key = effort.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ effort, description: entry.description });
    }
    const defaultEffort = model.defaultReasoningEffort?.trim();
    if (defaultEffort) {
      const key = defaultEffort.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        options.push({ effort: defaultEffort, description: "Default effort" });
      }
    }
  }
  return options;
}

function agentReferenceCandidates(
  channel: SerializedChannel,
  agent: SerializedAgent,
  agents: SerializedAgent[],
  localContext?: MentionLocalContext | null,
  instanceTargetScope: MentionInstanceTargetScope = "channel",
  reference = agent.name,
): MentionCandidate[] {
  const localMachineKeys = mentionLocalMachineKeys(localContext);
  const candidates: MentionCandidate[] = [];
  const cohort = agentsNamed(agents, agent.name);

  for (const member of cohort) {
    for (const instance of channelAgentInstances(channel, member, instanceTargetScope)) {
    const instanceIdentity = {
      kind: "agent" as const,
      status: instance.status,
      email: member.email,
      avatarUrl: agentRegistryAvatarUrl(member),
    };
    const mention = agentInstanceMentionLabel(instance.channelInstanceId ? member.name : reference, instance);
    candidates.push({
      id: `${member.id}:${instance.id}`,
      name: instance.label?.trim() || `Instance ${instance.channelInstanceId || ""}`.trim(),
      ...instanceIdentity,
      mention,
      local: isLocalAgentCandidate(localMachineKeys, member, instance),
      description: `Use @${mention}`,
      completionSuffix: " ",
      schemaNodeId: "agent-reference:instance",
    });
    candidates.push({
      id: `${member.id}:${instance.id}:reborn`,
      name: `Reborn ${instance.label?.trim() || `instance ${instance.channelInstanceId || ""}`.trim()}`,
      ...instanceIdentity,
      mention: `${mention}:reborn`,
      local: isLocalAgentCandidate(localMachineKeys, member, instance),
      description:
        instance.status === "offline"
          ? `Restart @${mention} in its channel slot with prior context`
          : `Kill live @${mention}, then reborn in its channel slot with prior context`,
      completionSuffix: " ",
      schemaNodeId: "agent-reference:reborn",
    });
    candidates.push({
      id: `${member.id}:${instance.id}:handoff`,
      name: `Hand off ${instance.label?.trim() || `instance ${instance.channelInstanceId || ""}`.trim()}`,
      ...instanceIdentity,
      mention: `${mention}:${AGENT_HANDOFF_ACTION_COMPLETION_SCHEMA.token}`,
      local: isLocalAgentCandidate(localMachineKeys, member, instance),
      action: "handoff-instance",
      description:
        instance.status === "offline"
          ? `Transfer @${mention}'s retained checkout to a new same-machine instance`
          : `Stop @${mention} and transfer its checkout to a new same-machine instance`,
      completionSuffix: AGENT_HANDOFF_ACTION_COMPLETION_SCHEMA.next?.delimiter || ":",
      schemaNodeId: AGENT_HANDOFF_ACTION_COMPLETION_SCHEMA.id,
    });
  }
  }

  return candidates;
}

function agentsNamed(agents: SerializedAgent[], name: string): SerializedAgent[] {
  const normalized = mentionToken(name);
  return agents.filter(agent => mentionToken(agent.name) === normalized);
}


function findMentionAgent(
  agents: SerializedAgent[],
  token: string,
  localContext?: MentionLocalContext | null,
): SerializedAgent | undefined {
  const normalized = mentionToken(token);
  const matches = agents.filter(agent => mentionToken(agent.name) === normalized);
  if (matches.length <= 1) return matches[0];
  const localMachineKeys = mentionLocalMachineKeys(localContext);
  return matches.find(agent => isLocalAgentCandidate(localMachineKeys, agent)) ?? matches[0];
}

export function channelAgentInstances(
  channel: SerializedChannel,
  agent: SerializedAgent,
  instanceTargetScope: MentionInstanceTargetScope = "channel"
): SerializedAgentInstance[] {
  if (instanceTargetScope === "none") return [];
  return channel.memberPresence?.[agent.id]?.instances || [];
}

function findAgentInstanceTarget(
  channel: SerializedChannel,
  agents: SerializedAgent[],
  targetToken: string,
  instanceTargetScope: MentionInstanceTargetScope = "channel"
): { agent: SerializedAgent; instance: SerializedAgentInstance; mention: string } | undefined {
  const matches: Array<{ agent: SerializedAgent; instance: SerializedAgentInstance; mention: string }> = [];
  for (const agent of agents) {
    for (const instance of channelAgentInstances(channel, agent, instanceTargetScope)) {
      if (mentionToken(agentInstanceMentionLabel(agent.name, instance)) === mentionToken(targetToken)) {
        matches.push({ agent, instance, mention: agentInstanceMentionLabel(agent.name, instance) });
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function findActiveMention(draft: string, cursor: number): ActiveMention | null {
  // A negative cursor is the composer's explicit dismissed-completion sentinel.
  // Do not let String#slice reinterpret it as an offset from the end and
  // immediately reopen the same panel after Escape.
  if (cursor < 0) return null;
  const beforeCursor = draft.slice(0, cursor);
  const at = beforeCursor.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(beforeCursor.charAt(at - 1))) return null;

  const query = beforeCursor.slice(at + 1);
  if (/\s/.test(query) && !AGENT_COMMAND_QUERY_RE.test(query)) return null;
  if (!/\s/.test(query) && !beforeCursor.match(MENTION_QUERY_RE)) return null;

  return {
    start: at,
    end: cursor,
    tokenEnd: mentionTokenEnd(draft, cursor),
    query,
  };
}

/**
 * Where the mention token ends, using the same close set as the shared mention
 * grammar: whitespace or a closing bracket. Equal to the caret when the human
 * is typing at the end of the token, which is the common case.
 */
function mentionTokenEnd(draft: string, cursor: number): number {
  let end = cursor;
  while (end < draft.length && !/[\s\]})]/u.test(draft.charAt(end))) end += 1;
  return end;
}

export function filterMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
  limit?: number
): MentionCandidate[] {
  const normalized = query.trim().toLowerCase();
  const commandQuery = normalized.includes(" /");
  const matches = normalized
    ? candidates.filter((candidate) => {
        const name = candidate.name.toLowerCase();
        const email = candidate.email?.toLowerCase() || "";
        const mention = candidate.mention?.toLowerCase() || "";
        const action =
          candidate.action?.startsWith("agent-goal-")
              ? candidate.name.toLowerCase()
              : candidate.action === "agent-model-switch"
                ? `switch model ${candidate.name.toLowerCase()}`
                : candidate.action === "agent-effort-switch"
                  ? `switch effort ${candidate.name.toLowerCase()}`
              : "";
        const app = candidate.kind === "app" ? "app connector integration" : "";
        const description = candidate.description?.toLowerCase() || "";
        const local = candidate.local ? "local this machine" : "";
        if (commandQuery) {
          return (
            (candidate.action?.startsWith("agent-goal-") ||
              candidate.action === "agent-model-switch" ||
              candidate.action === "agent-effort-switch") &&
            mention.startsWith(normalized)
          );
        }
        return (
          name.startsWith(normalized) ||
          name.includes(normalized) ||
          mention.includes(normalized) ||
          email.includes(normalized) ||
          action.includes(normalized) ||
          app.includes(normalized) ||
          description.includes(normalized) ||
          local.includes(normalized)
        );
      })
    : candidates;

  return typeof limit === "number" ? matches.slice(0, limit) : matches;
}

/**
 * An `@` is nearly always aimed at an Agent or a Human, so those two sections
 * start open. The lower-traffic kinds fold to a single line until the human
 * asks for them, which is what keeps the panel short enough to read.
 */
export const DEFAULT_OPEN_MENTION_KINDS: ReadonlyArray<MentionCandidate["kind"]> = ["agent", "user"];

/**
 * Rows an open section shows before it too offers a fold row. A Space with two
 * dozen Agents would otherwise push Human off the bottom of the panel, which
 * defeats the point of opening Human at all.
 */
export const DEFAULT_OPEN_MENTION_ROWS = 6;

export function groupedMentionCandidates(
  candidates: MentionCandidate[],
  options: number | MentionCandidateSectionOptions = 2
): MentionCandidateSection[] {
  const limitPerKind = typeof options === "number" ? options : options.limitPerKind ?? 2;
  const expandedKinds = new Set(
    typeof options === "number" ? [] : Array.from(options.expandedKinds || [])
  );
  const openKinds =
    typeof options === "number" || !options.openKinds ? null : new Set(options.openKinds);
  let startIndex = 0;
  return ([
    { kind: "launch", label: "Condition" },
    { kind: "service", label: "AI service" },
    { kind: "agent", label: "Agent" },
    { kind: "user", label: "Human" },
    { kind: "app", label: "App" },
  ] as const)
    .map((section) => {
      const sectionCandidates = candidates.filter((candidate) => candidate.kind === section.kind);
      const expanded = expandedKinds.has(section.kind);
      const open = expanded || !openKinds || openKinds.has(section.kind);
      const visibleCandidates = expanded
        ? sectionCandidates
        : open
          ? sectionCandidates.slice(0, limitPerKind)
          : [];
      const hiddenCount = Math.max(0, sectionCandidates.length - visibleCandidates.length);
      const result = {
        ...section,
        candidates: visibleCandidates,
        startIndex,
        totalCount: sectionCandidates.length,
        hiddenCount,
        expanded,
      };
      startIndex += visibleCandidates.length + (hiddenCount > 0 ? 1 : 0);
      return result;
    })
    .filter((section) => section.totalCount > 0);
}

export function completeMention(
  draft: string,
  cursor: number,
  candidate: MentionCandidate
): { value: string; cursor: number } {
  const active = findActiveMention(draft, cursor);
  if (!active) return { value: draft, cursor };

  // From the token end, not the caret: the picked candidate replaces the whole
  // mention the human is pointing at.
  const suffix = draft.slice(active.tokenEnd);
  // The trailing space only separates the mention from what follows it, so text
  // that already starts with whitespace needs no second one.
  const separator = candidate.completionSuffix ?? " ";
  const insert = `@${candidate.mention || candidate.name}${
    separator === " " && /^\s/u.test(suffix) ? "" : separator
  }`;
  const value = `${draft.slice(0, active.start)}${insert}${suffix}`;
  return {
    value,
    cursor: active.start + insert.length,
  };
}

export function parseAppMentions(
  draft: string,
  appConnectors: MentionAppConnector[]
): ParsedAppMention[] {
  const appsByMention = new Map(
    appConnectors.map((app) => [mentionToken(app.id || app.name), app])
  );
  const parsed: ParsedAppMention[] = [];
  const seen = new Set<string>();
  const mentionRe = /@([A-Za-z0-9._-]+)(?::([A-Za-z0-9._-]+))?/g;

  for (const match of draft.matchAll(mentionRe)) {
    const appToken = mentionToken(match[1]);
    const app = appsByMention.get(appToken);
    if (!app) continue;

    const actionToken = match[2] ? mentionToken(match[2]) : "";
    const action = actionToken
      ? (app.actions || []).find((item) => mentionToken(item.id) === actionToken)
      : undefined;
    const key = `${app.id}:${action?.id || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    parsed.push({
      token: match[0],
      appId: app.id,
      appName: app.name,
      status: app.status || "planned",
      actionId: action?.id,
      actionLabel: action?.label,
    });
  }

  return parsed;
}

export function mentionStatusRank(status: SerializedAgent["status"]): number {
  if (isLiveAgentStatus(status)) return 0;
  return 1;
}

function mentionLocalRank(candidate: MentionCandidate): number {
  return candidate.kind === "agent" && candidate.local ? 0 : 1;
}

function agentSupportsGoalCommand(
  agent: SerializedAgent,
  instance?: { capabilities?: string[] }
): boolean {
  if (instance?.capabilities?.includes("goal")) return true;
  // Compatibility fallback for runtimes that predate capability advertising.
  // Current Codex, Claude Code, Grok Build, and ZCode instances report `goal`
  // plus their exact `goal.*` operation set.
  const type = agent.type?.toLowerCase() || "";
  return (
    type.includes("codex") ||
    type.includes("claude") ||
    type.includes("grok") ||
    type.includes("zcode")
  );
}

function agentSupportsGoalControl(
  instance: { capabilities?: string[] },
  control: string
): boolean {
  const operation = control === "status" ? "get" : control;
  const detailed = (instance.capabilities || []).filter((capability) =>
    capability.startsWith("goal.")
  );
  if (detailed.length === 0) {
    // Older runtimes advertised only the coarse goal feature. Preserve their
    // established controls without claiming newer pause/replace support.
    return ["resume", "status", "clear"].includes(control);
  }
  return detailed.includes(`goal.${operation}`);
}

export function agentInstanceMentionLabel(
  agentName: string,
  instance: { id?: string; channelInstanceId?: string; label?: string }
): string {
  const channelInstanceId = instance.channelInstanceId?.trim();
  if (channelInstanceId) return `${agentName}:${channelInstanceId}`;
  const label = instance.label?.trim().replace(/^@/, "");
  if (label?.toLowerCase().startsWith(`${agentName.toLowerCase()}:`)) {
    return label;
  }
  return agentName;
}

export function isLocalAgentCandidate(
  localMachineKeys: Set<string>,
  agent?: SerializedAgent,
  instance?: { machineId?: string; hostId?: string; hostName?: string }
): boolean {
  if (localMachineKeys.size === 0) return false;

  const instanceKeys = instance ? mentionMachineKeys(instance) : [];
  if (instanceKeys.length > 0) {
    return instanceKeys.some((key) => localMachineKeys.has(key));
  }

  if (!agent) return false;
  return agentMachineKeys(agent).some((key) => localMachineKeys.has(key));
}

export function mentionLocalMachineKeys(context?: MentionLocalContext | null): Set<string> {
  return new Set(
    [context?.machineId]
      .map(normalizeMachineKey)
      .filter(Boolean)
  );
}

function agentMachineKeys(agent?: SerializedAgent): string[] {
  if (!agent) return [];
  return mentionMachineKeys({
    machineId: metadataString(agent.metadata, "machineId"),
    hostId: metadataString(agent.metadata, "hostId"),
    hostName:
      metadataString(agent.metadata, "hostName") ||
      metadataString(agent.metadata, "hostname"),
  });
}

function mentionMachineKeys(input: {
  machineId?: string;
  hostId?: string;
  hostName?: string;
}): string[] {
  return [input.machineId]
    .map(normalizeMachineKey)
    .filter(Boolean);
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

function normalizeMachineKey(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedMachineKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
}

function daemonMatchesLocalMachine(daemon: SerializedMachineDaemon, localKeys: string[]): boolean {
  return normalizedMachineKeys([
    daemon.machineId || "",
  ]).some((key) => localKeys.includes(key));
}

function mentionToken(value: string): string {
  return value.trim().replace(/^@/, "").replace(/\s+/g, "-").toLowerCase();
}
