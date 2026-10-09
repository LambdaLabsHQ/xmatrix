const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  appCompletionCacheKey,
  channelInteractionTargets,
  channelMentionCandidates,
  completeMention,
  connectorCompletionErrorMessage,
  connectorCompletionRecovery,
  DEFAULT_OPEN_MENTION_KINDS,
  DEFAULT_OPEN_MENTION_ROWS,
  filterMentionCandidates,
  findActiveMention,
  groupedMentionCandidates,
  localMentionContextFromDaemon,
  parseAppMentions,
  resolveMentionCompletion,
} = require("./mention-complete.ts");

/** An open Channel in `space-1`; `overrides` carry what the test is about. */
function openChannel(overrides = {}) {
  return {
    id: "channel-1",
    spaceId: "space-1",
    mode: "open",
    memberPresence: {},
    createdBy: "user-1",
    createdAt: "2026-05-07T00:00:00Z",
    updatedAt: "2026-05-07T00:00:00Z",
    ...overrides,
  };
}

/** A Channel where Agent `name` has one live instance, `name:1`, carrying `instance`. */
function agentPresenceChannel(name, status, instances) {
  return openChannel({ memberPresence: { [`agent:${name}`]: { kind: "agent", status, label: name, instances } } });
}

function liveInstanceChannel(name, status, instance = {}) {
  return openChannel({
    memberPresence: {
      [`agent:${name}`]: {
        kind: "agent",
        status,
        label: name,
        instances: [
          {
            id: "instance-one",
            channelInstanceId: "1",
            label: `${name}:1`,
            status,
            ...instance,
            connectedAt: "2026-05-07T00:00:00Z",
            lastSeenAt: "2026-05-07T00:00:00Z",
          },
        ],
      },
    },
  });
}

/** An instance catalog running GPT-5.4 at medium effort, offering `efforts`. */
function gpt54AtMediumEffort(efforts) {
  return {
    model: "gpt-5.4",
    effort: "medium",
    models: [
      {
        id: "gpt-5.4",
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: efforts,
      },
    ],
  };
}

/** The Agent behind a {@link liveInstanceChannel}. */
function liveAgent(name, type, status) {
  return { id: `agent:${name}`, name, type, kind: "agent", status, email: "agent@example.com" };
}

/** Completion with the caret at the end of `text`. */
function codexCommandFixture(channel) {
  const agents = [liveAgent("codex", "codex", "idle")];
  const commands = resolveAtEnd("@codex:1 /", channel, agents);
  assert.equal(commands.stage, "agent-command");
  return { agents, commands };
}

function resolveAtEnd(text, channel, agents) {
  return resolveMentionCompletion(text, text.length, members(channel, agents));
}

/**
 * The Channel as its Agent members see it: each described Agent that is present
 * becomes a registration member (label + owner/machine/harness). An Agent with
 * no presence here is not a member and contributes nothing.
 */
function members(channel, agents) {
  if (!channel) return channel;
  const memberPresence = { ...channel.memberPresence };
  for (const agent of agents || []) {
    const presence = memberPresence[agent.id];
    if (!presence || presence.kind !== "agent") continue;
    memberPresence[agent.id] = {
      ...presence,
      label: presence.label || agent.name,
      ...(agent.email && !presence.email ? { email: agent.email } : {}),
      ...(agent.avatarUrl && !presence.avatarUrl ? { avatarUrl: agent.avatarUrl } : {}),
      registration: presence.registration || {
        ownerUserId: agent.userId || "owner",
        machineId: agent.metadata?.machineId || "machine",
        harness: agent.type || agent.name,
      },
    };
  }
  return { ...channel, memberPresence };
}

test("same-name Agent members collapse without retired launch targets", () => {
  const live = (id, harness, machineId) => ({ kind: "agent", label: harness,
    registration: { ownerUserId: "owner", machineId, harness },
    instances: [{ id, channelInstanceId: id.slice(-1), label: `${harness}:${id.slice(-1)}`, status: "online" }] });
  const channel = { id: "channel", spaceId: "space", mode: "open", memberPresence: {
    "channel:1": live("channel:1", "codex", "macbook"),
    "channel:2": live("channel:2", "codex", "server"),
    "channel:3": live("channel:3", "grok", "workstation"),
  } };
  const choices = channelMentionCandidates(channel).filter(item => item.kind === "agent");
  assert.deepEqual(choices.map(item => item.mention), ["codex", "grok"]);
  const actions = resolveMentionCompletion("@codex:", 7, channel);
  assert.equal(actions.candidates.some(item => item.action === "create-instance"), false);
  assert.equal(actions.launchTargetsRequest, undefined);
  const targets = resolveMentionCompletion("@codex:new:", 11, channel);
  assert.notEqual(targets.stage, "agent-launch-target");
  assert.equal(targets.launchTargetsRequest, undefined);
});

test("same-name Instances are addressed by their Channel slot for reply, reborn and commands", () => {
  const channel = { id: "channel", spaceId: "space", mode: "open", memberPresence: Object.fromEntries(
    [2, 3].map((slot) => [`channel:${slot}`, { kind: "agent", label: "codex",
      registration: { ownerUserId: "owner", machineId: `machine-${slot}`, harness: "codex" },
      instances: [{ id: `channel:${slot}`, channelInstanceId: String(slot), label: `codex:${slot}`,
        status: "online", capabilities: ["goal"] }] }])) };
  const references = resolveMentionCompletion("@codex:3", 8, channel);
  assert.ok(references.candidates.some(candidate => candidate.mention === "codex:3"));
  assert.ok(references.candidates.some(candidate => candidate.mention === "codex:3:reborn"));
  assert.equal(references.candidates.some(candidate => candidate.mention === "codex:2"), false);
  const commands = resolveMentionCompletion("@codex:3 /", 10, channel);
  assert.equal(commands.stage, "agent-command");
  assert.ok(commands.candidates.length > 0);
  assert.ok(commands.candidates.every(candidate => candidate.mention?.startsWith("codex:3 /")));
  // An Instance id is not an address.
  const byId = "@channel:3:3 /";
  assert.equal(resolveMentionCompletion(byId, byId.length, channel).candidates.length, 0);
});

test("connectorCompletionErrorMessage explains connector completion failures", () => {
  assert.equal(
    connectorCompletionErrorMessage("github_api_403"),
    "GitHub did not return the installation repositories. Check GitHub access and retry."
  );
  assert.equal(
    connectorCompletionErrorMessage("network error"),
    "Could not load GitHub completion options. Retry or check the connector configuration."
  );
});

test("connectorCompletionRecovery selects an actionable recovery", () => {
  assert.equal(connectorCompletionRecovery("App connection not found"), "configure");
  assert.equal(connectorCompletionRecovery("github_installation_missing"), "configure");
  assert.equal(connectorCompletionRecovery("Channel not found"), null);
  assert.equal(connectorCompletionRecovery("github_api_403"), "retry");
});

test("appCompletionCacheKey isolates dynamic connector values by channel", () => {
  assert.notEqual(
    appCompletionCacheKey("space-1", "channel-1", "github", "github-organizations"),
    appCompletionCacheKey("space-1", "channel-2", "github", "github-organizations")
  );
});

test("channelMentionCandidates does not rank Agent identities by aggregate presence status", () => {
  const channel = openChannel({
    memberPresence: {
      "user:1": {
        kind: "user",
        status: "online",
      },
      "agent:offline": { kind: "agent", status: "offline", label: "codex-offline" },
      "agent:online": {
        kind: "agent",
        status: "online",
        label: "codex-online",
        instances: [
          {
            id: "instance-online-1234",
            label: "codex-online",
            status: "online",
            connectedAt: "2026-05-07T00:00:00Z",
            lastSeenAt: "2026-05-07T00:00:00Z",
          },
        ],
      },
    },
  });

  assert.deepEqual(
    channelMentionCandidates(members(channel, []), null, [], {
      id: "space-1",
      members: [{ userId: "1", name: "Yiming Hu" }],
    })
      .map((candidate) => `${candidate.name}:${candidate.action || "mention"}`),
    [
      "Yiming Hu:mention",
      "codex-offline:mention",
      "codex-online:mention",
    ]
  );
});

test("segmented completion does not offer unparseable member names", () => {
  const member = (id, label) => ({ kind: "agent", label,
    registration: { ownerUserId: "owner", machineId: "machine", harness: "claude" },
    instances: [{ id, channelInstanceId: id.slice(-1), label: `${label}:${id.slice(-1)}`, status: "offline" }] });
  const channel = openChannel({
    memberPresence: {
      "channel-1:1": member("channel-1:1", "Claude Code (VSCode)"),
      "channel-1:2": member("channel-1:2", "claude-vscode"),
    },
  });

  assert.deepEqual(
    channelMentionCandidates(channel).map((candidate) => candidate.mention || candidate.name),
    ["claude-vscode"]
  );
});

test("channelMentionCandidates ranks members on this machine first and labels them", () => {
  const member = (id, label, machineId) => ({ kind: "agent", label,
    registration: { ownerUserId: "owner", machineId, harness: "codex" },
    instances: [{ id, channelInstanceId: "1", label: `${label}:1`, status: "online" }] });
  const channel = openChannel({
    memberPresence: {
      "user:1": { kind: "user", status: "online", label: "Yiming Hu", email: "yiming@example.com" },
      "channel-1:1": member("channel-1:1", "remote-codex", "remote-machine"),
      "channel-1:2": member("channel-1:2", "local-codex", "local-machine"),
    },
  });

  const candidates = channelMentionCandidates(channel, { machineId: "local-machine" }, [], {
    id: "space-1",
    members: [{ userId: "1", name: "Yiming Hu", email: "yiming@example.com" }],
  });

  // Agent identities are status-neutral; the member on this machine leads.
  assert.deepEqual(
    candidates.map((candidate) => `${candidate.name}:${candidate.local ? "local" : "remote"}`),
    ["local-codex:local", "Yiming Hu:remote", "remote-codex:remote"]
  );
});

test("segmented completion labels local live agent instances by Machine id", () => {
  const channel = agentPresenceChannel("codex", "online", [
          {
            id: "instance-local-1234",
            label: "codex:1",
            status: "online",
            hostId: "local-host",
            machineId: "local-machine",
            connectedAt: "2026-05-07T00:00:00Z",
            lastSeenAt: "2026-05-07T00:00:00Z",
          },
        ]);

  const agents = [{ id: "agent:codex", name: "codex", kind: "agent", status: "online" }];
  const result = resolveMentionCompletion(
    "@codex:",
    "@codex:".length,
    members(channel, agents),
    { machineId: "local-machine" }
  );

  assert.equal(result.candidates.find((candidate) => candidate.mention === "codex:1").local, true);
});

test("a member is local only by its registration machine, never by a name or host alias", () => {
  const channel = openChannel({
    memberPresence: {
      "channel-1:1": { kind: "agent", label: "codex-xmatrix-devs-macbook-air",
        registration: { ownerUserId: "owner", machineId: "machine-a", harness: "codex" },
        instances: [{ id: "channel-1:1", channelInstanceId: "1", label: "codex:1", status: "online" }] },
    },
  });

  for (const context of [{ hostId: "devs-macbook-air" }, { hostName: "Devs-MacBook-Air.local" }]) {
    assert.equal(channelMentionCandidates(channel, context)[0].local, false);
  }
  assert.equal(channelMentionCandidates(channel, { machineId: "machine-a" })[0].local, true);
});

test("localMentionContextFromDaemon refuses hostname matching without a desktop Machine id", () => {
  const context = localMentionContextFromDaemon(
    [
      {
        id: "agent:daemon-remote",
        userId: "user:1",
        name: "xmatrix-daemon-remote-host",
        email: "daemon@example.com",
        status: "online",
        connectedAt: "2026-05-07T00:00:00Z",
        lastSeenAt: "2026-05-07T00:00:00Z",
        metadata: { kind: "daemon", hostId: "remote-host", hostName: "remote-host" },
        hostId: "remote-host",
        hostName: "remote-host",
      },
      {
        id: "agent:daemon-local",
        userId: "user:1",
        name: "xmatrix-daemon-local-host",
        email: "daemon@example.com",
        status: "online",
        connectedAt: "2026-05-07T00:00:00Z",
        lastSeenAt: "2026-05-07T00:00:00Z",
        metadata: { kind: "daemon", hostId: "local-host", hostName: "local-host" },
        hostId: "local-host",
        hostName: "local-host",
      },
    ],
    { hostId: "local-host", hostName: "local-host" }
  );

  assert.equal(context, null);
});

test("localMentionContextFromDaemon requires a matching daemon", () => {
  assert.equal(
    localMentionContextFromDaemon([], { machineId: "machine-1", hostId: "local-host", hostName: "Local Host" }),
    null
  );
});

test("localMentionContextFromDaemon prefers an online local daemon over a stale record", () => {
  const context = localMentionContextFromDaemon(
    [
      {
        id: "agent:daemon-stale",
        userId: "user:1",
        name: "xmatrix-daemon-local-host-stale",
        email: "daemon@example.com",
        status: "offline",
        connectedAt: "2026-05-07T00:00:00Z",
        lastSeenAt: "2026-05-07T00:00:00Z",
        metadata: { kind: "daemon", machineId: "machine:local", hostId: "local-host" },
        machineId: "machine:local",
        hostId: "local-host",
      },
      {
        id: "agent:daemon-online",
        userId: "user:1",
        name: "xmatrix-daemon-local-host",
        email: "daemon@example.com",
        status: "online",
        connectedAt: "2026-05-07T00:01:00Z",
        lastSeenAt: "2026-05-07T00:01:00Z",
        metadata: { kind: "daemon", machineId: "machine:local", hostId: "local-host", hostName: "Local Host" },
        machineId: "machine:local",
        hostId: "local-host",
        hostName: "Local Host",
      },
    ],
    { machineId: "machine:local", hostId: "local-host" }
  );

  assert.equal(context.hostName, "Local Host");
});

test("segmented completion uses channel-local instance labels for live references", () => {
  const channel = agentPresenceChannel("codex", "online", [
          {
            id: "instance-two",
            channelInstanceId: "2",
            label: "codex:2",
            status: "online",
            connectedAt: "2026-05-07T00:00:00Z",
            lastSeenAt: "2026-05-07T00:00:00Z",
          },
          {
            id: "instance-one",
            channelInstanceId: "1",
            label: "codex",
            status: "online",
            connectedAt: "2026-05-07T00:01:00Z",
            lastSeenAt: "2026-05-07T00:01:00Z",
          },
        ]);

  const agents = [{ id: "agent:codex", name: "codex", kind: "agent", status: "online" }];
  const root = resolveMentionCompletion("@cod", "@cod".length, members(channel, agents));
  const references = resolveMentionCompletion("@codex:", "@codex:".length, members(channel, agents));

  assert.equal(root.stage, "target");
  assert.deepEqual(root.candidates.map((candidate) => candidate.mention), ["codex"]);
  assert.equal(references.stage, "agent-reference");
  assert.deepEqual(
    references.candidates.map((candidate) => candidate.mention),
    ["codex:2", "codex:2:reborn", "codex:2:handoff", "codex:1", "codex:1:reborn", "codex:1:handoff"]
  );
});

test("agent reference stage keeps offline instances without offering a bare mention", () => {
  const channel = liveInstanceChannel("codex", "offline");

  const agents = [{ id: "agent:codex", name: "codex", kind: "agent", status: "offline" }];
  const references = resolveMentionCompletion("@codex:", "@codex:".length, members(channel, agents));

  assert.deepEqual(
    references.candidates.map((candidate) => candidate.mention),
    ["codex:1", "codex:1:reborn", "codex:1:handoff"]
  );
});

test("handoff successor stage offers the Space's registered harnesses as a new instance", () => {
  const channel = openChannel({
    memberPresence: {
      "channel-1:1": {
        kind: "agent",
        label: "codex",
        registration: { ownerUserId: "owner", machineId: "machine-a", harness: "codex" },
        instances: [{ id: "channel-1:1", channelInstanceId: "1", label: "codex:1", status: "offline",
          machineId: "machine-a", connectedAt: "2026-05-07T00:00:00Z", lastSeenAt: "2026-05-07T00:00:00Z" }],
      },
    },
  });

  const draft = "@codex:1:handoff:";
  const result = resolveMentionCompletion(draft, draft.length, channel, null, [], null, {}, "channel",
    ["codex", "grok", "codex", "xmatrix"]);
  assert.equal(result.stage, "handoff-successor");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.mention),
    ["codex:1:handoff:@codex", "codex:1:handoff:@grok"],
  );
});

test("agent references never offer retired start actions", () => {
  const channel = openChannel();
  const agents = [
    {
      id: "agent:codex",
      userId: "user-1",
      name: "codex",
      kind: "agent",
      status: "offline",
      metadata: { machineId: "machine-1" },
    },
  ];

  const references = resolveMentionCompletion(
    "@codex:",
    "@codex:".length,
    members(channel, agents),
    null,
    [],
    null,
    {}
  );

  assert.deepEqual(
    references.candidates.map(
      (candidate) => `${candidate.mention}:${candidate.action}:${candidate.startToken}`
    ),
    []
  );

  // Retired tokens cannot reach any start action.
  const once = resolveMentionCompletion(
    "@codex:onc",
    "@codex:onc".length,
    members(channel, agents),
    null,
    [],
    null,
    {}
  );
  assert.deepEqual(once.candidates.map((candidate) => candidate.mention), []);

  const none = resolveMentionCompletion(
    "@codex:unrelated",
    "@codex:unrelated".length,
    members(channel, agents),
    null,
    [],
    null,
    {}
  );
  assert.equal(none.candidates.length, 0);
});

test("retired launch suffixes have no target completion", () => {
  const channel = openChannel();
  const agents = [{
    id: "agent:codex",
    userId: "user-1",
    name: "codex",
    kind: "agent",
    status: "offline",
  }];

  for (const [draft] of [
    ["@codex:new:", "new"],
    ["@codex:once!:", "once"],
    ["Restore this draft: @codex:new:LambdaLabsHQ/xmatrix", "new"],
  ]) {
    const completion = resolveMentionCompletion(
      draft,
      draft.length,
      members(channel, agents),
      null,
      [],
      { id: "space-1", members: [] }
    );
    assert.notEqual(completion.stage, "agent-launch-target", draft);
    assert.equal(completion.agentLaunchTarget, undefined, draft);
    assert.equal(completion.launchTargetsRequest, undefined, draft);
    // Retired input must not initiate target discovery.
    assert.equal(completion.dynamicRequest, undefined, draft);
  }
});

test("the retired reference picker does not request launch targets", () => {
  const channel = openChannel({ createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" });
  const agents = [{
    id: "agent:daniel-codex-mba",
    userId: "user-1",
    name: "daniel-codex-mba",
    kind: "agent",
    status: "offline",
    metadata: { machineId: "machine-mba" },
  }];

  const actionStage = resolveMentionCompletion(
    "@daniel-codex-mba:",
    "@daniel-codex-mba:".length,
    members(channel, agents),
    null,
    [],
    { id: "space-1", members: [] },
    {}
  );
  assert.equal(actionStage.launchTargetsRequest, undefined);
  assert.deepEqual(actionStage.candidates.map((candidate) => candidate.mention), []);
});

test("typed and restored retired launch suffixes have no candidates", () => {
  const channel = openChannel({ createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" });
  const agents = [{
    id: "agent:codex",
    userId: "user-1",
    name: "codex",
    kind: "agent",
    status: "offline",
    metadata: { machineId: "machine-1" },
  }];

  for (const draft of ["@codex:new:", "@codex:once:LambdaLabsHQ/xmatrix", "@codex:once!:repo"]) {
    const completion = resolveMentionCompletion(
      draft,
      draft.length,
      members(channel, agents),
      null,
      [],
      null,
      {},
      []
    );
    assert.notEqual(completion.stage, "agent-launch-target", draft);
    assert.equal(completion.agentLaunchTarget, undefined);
    assert.equal(completion.candidates.length, 0, draft);
  }
});

test("retired launch suffixes do not query another member's directories", () => {
  const channel = {
    id: "channel-1",
    spaceId: "space-1",
    mode: "open",
    memberPresence: {},
    createdBy: "user-1",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
  const agents = [{
    id: "agent:remote-codex",
    userId: "user-2",
    name: "remote-codex",
    kind: "agent",
    status: "offline",
    metadata: { machineId: "machine-2" },
  }];

  const completion = resolveMentionCompletion(
    "@remote-codex:",
    "@remote-codex:".length,
    members(channel, agents),
    null,
    [],
    null,
    {}
  );
  assert.equal(completion.launchTargetsRequest, undefined);
  assert.deepEqual(completion.candidates.map((candidate) => candidate.mention), []);
});

test("segmented completion resolves static goal commands for live Codex instances", () => {
  const channel = liveInstanceChannel("codex", "online");

  const agents = [liveAgent("codex", "codex", "online")];
  const commands = resolveAtEnd("@codex:1 /", channel, agents);
  const goalCommands = resolveAtEnd("@codex:1 /goal ", channel, agents);

  assert.deepEqual(
    commands.candidates.map((candidate) => `${candidate.name}:${candidate.mention}:${candidate.action}`),
    ["Goal:codex:1 /goal:agent-goal-set"]
  );
  assert.equal(goalCommands.stage, "agent-goal");
  assert.equal(goalCommands.stageLabel, "Type a new goal, or choose an action below");
  assert.deepEqual(
    goalCommands.candidates.map((candidate) => `${candidate.name}:${candidate.mention}:${candidate.action}`),
    [
      "Resume goal:codex:1 /goal resume:agent-goal-resume",
      "Goal status:codex:1 /goal status:agent-goal-status",
      "Clear goal:codex:1 /goal clear:agent-goal-clear",
    ]
  );
});

test("segmented completion resolves models from the live instance catalog", () => {
  const channel = liveInstanceChannel("codex", "idle", {
    model: "gpt-5.4",
    models: [
      { id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4" },
      { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5" },
    ],
  });

  const agents = [liveAgent("codex", "codex", "idle")];
  const commands = resolveAtEnd("@codex:1 /", channel, agents);
  const modelResult = resolveAtEnd("@codex:1 /model ", channel, agents);
  const modelCandidates = modelResult.candidates;

  assert.equal(commands.stage, "agent-command");
  assert.deepEqual(commands.candidates.map((candidate) => candidate.mention), [
    "codex:1 /model",
    "codex:1 /goal",
  ]);
  assert.equal(modelResult.stage, "agent-model");

  assert.deepEqual(
    modelCandidates.map((candidate) => ({
      action: candidate.action,
      mention: candidate.mention,
      description: candidate.description,
    })),
    [
      {
        action: "agent-model-switch",
        mention: "codex:1 /model gpt-5.4",
        description: "Current model",
      },
      {
        action: "agent-model-switch",
        mention: "codex:1 /model gpt-5.5",
        description: "Switch to gpt-5.5",
      },
    ]
  );
  assert.deepEqual(
    resolveAtEnd("@codex:1 /model gpt-5.5", channel, agents).candidates.map((candidate) => candidate.mention),
    ["codex:1 /model gpt-5.5"]
  );
  assert.deepEqual(
    completeMention("@codex:1 /model gpt-5", "@codex:1 /model gpt-5".length, modelCandidates[1]),
    {
      value: "@codex:1 /model gpt-5.5 ",
      cursor: "@codex:1 /model gpt-5.5 ".length,
    }
  );
});

test("segmented completion resolves efforts from the live instance catalog", () => {
  const channel = liveInstanceChannel("codex", "idle", {
    ...gpt54AtMediumEffort([
      { reasoningEffort: "low", description: "Lower latency" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Higher quality" },
    ]),
  });

  const { agents, commands } = codexCommandFixture(channel);
  assert.ok(
    commands.candidates.some((candidate) => candidate.mention === "codex:1 /model"),
    "model command available when models are present"
  );
  assert.ok(
    commands.candidates.some(
      (candidate) =>
        candidate.mention === "codex:1 /effort" && candidate.action === "agent-effort-switch"
    ),
    "effort command available when effort catalog is present"
  );

  const effortResult = resolveAtEnd("@codex:1 /effort ", channel, agents);
  assert.equal(effortResult.stage, "agent-effort");
  assert.deepEqual(
    effortResult.candidates.map((candidate) => ({
      action: candidate.action,
      mention: candidate.mention,
      description: candidate.description,
    })),
    [
      {
        action: "agent-effort-switch",
        mention: "codex:1 /effort low",
        description: "Lower latency",
      },
      {
        action: "agent-effort-switch",
        mention: "codex:1 /effort medium",
        description: "Current effort",
      },
      {
        action: "agent-effort-switch",
        mention: "codex:1 /effort high",
        description: "Higher quality",
      },
    ]
  );
  assert.deepEqual(
    completeMention(
      "@codex:1 /effort hi",
      "@codex:1 /effort hi".length,
      effortResult.candidates[2]
    ),
    {
      value: "@codex:1 /effort high ",
      cursor: "@codex:1 /effort high ".length,
    }
  );
});

test("segmented completion prefers advertised instance commands over static schema", () => {
  const channel = liveInstanceChannel("codex", "idle", {
    ...gpt54AtMediumEffort([{ reasoningEffort: "low" }, { reasoningEffort: "medium" }]),
    commands: [
      {
        token: "/model",
        label: "Model",
        mode: "typed",
        argumentSource: "agent-models",
      },
      {
        token: "/effort",
        label: "Effort",
        mode: "typed",
        argumentSource: "agent-efforts",
      },
      {
        token: "/reasoning",
        label: "Reasoning effort",
        mode: "typed",
        argumentSource: "agent-efforts",
      },
      {
        token: "/goal",
        label: "Set goal",
        description: "Set a persistent goal for the session.",
        mode: "typed",
        freeform: true,
      },
      {
        token: "/compact",
        label: "Compact",
        description: "Compact context",
        mode: "passthrough",
      },
      {
        token: "/diff",
        label: "Diff",
        description: "Show git diff",
        mode: "passthrough",
      },
    ],
  });

  const { agents, commands } = codexCommandFixture(channel);
  assert.deepEqual(
    commands.candidates.map((candidate) => ({
      mention: candidate.mention,
      action: candidate.action,
      description: candidate.description,
    })),
    [
      {
        mention: "codex:1 /model",
        action: "agent-model-switch",
        description: undefined,
      },
      {
        mention: "codex:1 /effort",
        action: "agent-effort-switch",
        description: undefined,
      },
      {
        mention: "codex:1 /reasoning",
        action: "agent-effort-switch",
        description: undefined,
      },
      {
        mention: "codex:1 /goal",
        action: "agent-goal-set",
        description: "Type a new goal or choose a goal control command.",
      },
      {
        mention: "codex:1 /compact",
        action: undefined,
        description: "Compact context",
      },
      {
        mention: "codex:1 /diff",
        action: undefined,
        description: "Show git diff",
      },
    ]
  );

  const filtered = resolveAtEnd("@codex:1 /compact", channel, agents);
  assert.deepEqual(
    filtered.candidates.map((candidate) => candidate.mention),
    ["codex:1 /compact"]
  );
  assert.equal(
    commands.candidates.find((candidate) => candidate.mention === "codex:1 /goal")?.name,
    "Goal",
    "the UI should not present the freeform-plus-controls entry as only a set action"
  );
});

for (const { label, name, type } of [
  { label: "Claude", name: "claude", type: "claude_code" },
  { label: "Grok", name: "grok", type: "grok" },
]) {
  test(`segmented completion resolves goal commands for live ${label} instances`, () => {
    const channel = liveInstanceChannel(name, "online");

    const agents = [liveAgent(name, type, "online")];
    const slashRoot = resolveAtEnd(`@${name}:1 /`, channel, agents);
    const result = resolveAtEnd(`@${name}:1 /goal `, channel, agents);

    assert.ok(
      slashRoot.candidates.some((candidate) => candidate.mention === `${name}:1 /goal`),
      `${label} live instances should offer /goal`
    );
    assert.equal(result.stage, "agent-goal");
    assert.deepEqual(
      result.candidates.map((candidate) => `${candidate.name}:${candidate.action}`),
      [
        "Resume goal:agent-goal-resume",
        "Goal status:agent-goal-status",
        "Clear goal:agent-goal-clear",
      ]
    );
  });
}

test("segmented completion exposes the exact advertised ZCode goal controls", () => {
  const channel = {
    id: "channel-1",
    spaceId: "space-1",
    mode: "open",
    memberPresence: {
      "agent:zcode": {
        kind: "agent",
        status: "online",
        label: "zcode",
        instances: [
          {
            id: "instance-one",
            channelInstanceId: "1",
            label: "zcode:1",
            status: "online",
            capabilities: [
              "goal",
              "goal.set",
              "goal.replace",
              "goal.get",
              "goal.clear",
              "goal.pause",
              "goal.resume",
            ],
          },
        ],
      },
    },
  };
  const agents = [
    {
      id: "agent:zcode",
      name: "zcode",
      type: "zcode",
      kind: "agent",
      status: "online",
    },
  ];

  const result = resolveAtEnd("@zcode:1 /goal ", channel, agents);

  assert.deepEqual(
    result.candidates.map((candidate) => `${candidate.name}:${candidate.action}`),
    [
      "Replace goal:agent-goal-replace",
      "Resume goal:agent-goal-resume",
      "Pause goal:agent-goal-pause",
      "Goal status:agent-goal-status",
      "Clear goal:agent-goal-clear",
    ]
  );
});

test("channelMentionCandidates does not add goal actions for unsupported runtimes", () => {
  const channel = liveInstanceChannel("aider", "online");

  assert.deepEqual(
    channelMentionCandidates(members(channel, [
      {
        id: "agent:aider",
        name: "aider",
        type: "aider",
        kind: "agent",
        status: "online",
        email: "agent@example.com",
      },
    ])).map((candidate) => `${candidate.name}:${candidate.action || "mention"}`),
    ["aider:mention"]
  );
});

test("channelMentionCandidates carries member avatar URLs into mention suggestions", () => {
  const channel = openChannel({
    memberPresence: {
      "user:1": {
        kind: "user",
        status: "online",
        label: "Yiming Hu",
        email: "yiming@example.com",
        avatarUrl: "https://example.com/yiming.png",
      },
    },
  });
  const space = {
    id: "space-1",
    members: [
      {
        userId: "1",
        name: "Yiming Hu",
        email: "yiming@example.com",
        avatarUrl: "https://example.com/yiming.png",
      },
    ],
  };

  const human = channelMentionCandidates(members(channel, []), null, [], space)
    .find((candidate) => candidate.kind === "user");
  assert.equal(human.avatarUrl, "https://example.com/yiming.png");
  assert.equal(human.mention, "Yiming Hu");
  assert.equal(completeMention("@Yi", 3, human).value, "@Yiming Hu ");
  space.members[0].handle = "old-handle";
  assert.equal(channelMentionCandidates(members(channel, []), null, [], space)
    .find((candidate) => candidate.kind === "user").mention, "Yiming Hu");
  space.members[0].name = "everyone";
  assert.equal(channelMentionCandidates(members(channel, []), null, [], space)
    .find((candidate) => candidate.kind === "user").mention, "old-handle");

});

test("channelMentionCandidates joins visible Human ids with the Space member directory", () => {
  const channel = {
    id: "channel-1",
    spaceId: "space-1",
    mode: "closed",
    visibleHumanMemberIds: ["user:offline", "user:online"],
    memberPresence: {
      "user:online": {
        kind: "user",
        status: "online",
        label: "Stale live label",
      },
      "user:not-authorized": {
        kind: "user",
        status: "online",
        label: "Not Authorized",
      },
    },
    createdBy: "user-online",
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:00:00Z",
  };
  const space = {
    id: "space-1",
    members: [
      {
        userId: "offline",
        name: "Offline Person",
        email: "offline@example.com",
        avatarUrl: "https://example.com/offline.png",
      },
      {
        userId: "online",
        name: "Online Person",
        email: "online@example.com",
      },
      {
        userId: "not-authorized",
        name: "Not Authorized",
        email: "hidden@example.com",
      },
    ],
  };

  const humans = resolveMentionCompletion(
    "@",
    1,
    members(channel, []),
    null,
    [],
    space
  ).candidates.filter((candidate) => candidate.kind === "user");

  assert.deepEqual(
    humans.map(({ id, name, status, email, avatarUrl }) => ({ id, name, status, email, avatarUrl })),
    [
      {
        id: "user:online",
        name: "Online Person",
        status: "online",
        email: "online@example.com",
        avatarUrl: undefined,
      },
      {
        id: "user:offline",
        name: "Offline Person",
        status: "offline",
        email: "offline@example.com",
        avatarUrl: "https://example.com/offline.png",
      },
    ]
  );
});

test("filterMentionCandidates matches names and human emails", () => {
  const candidates = [
    { id: "agent:1", name: "codex-xmatrix-workstation", kind: "agent", status: "online" },
    { id: "user:1", name: "Yiming Hu", kind: "user", status: "online", email: "yiming@example.com" },
  ];

  assert.deepEqual(filterMentionCandidates(candidates, "xmat").map((item) => item.name), [
    "codex-xmatrix-workstation",
  ]);
  assert.deepEqual(filterMentionCandidates(candidates, "example").map((item) => item.name), [
    "Yiming Hu",
  ]);
});

test("filterMentionCandidates returns every match by default", () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    id: `user:${index}`,
    name: `Member ${index}`,
    kind: "user",
    status: "online",
  }));

  assert.equal(filterMentionCandidates(candidates, "member").length, 8);
  assert.equal(filterMentionCandidates(candidates, "member", 6).length, 6);
});

test("filterMentionCandidates matches create new instance actions", () => {
  const candidates = [
    {
      id: "agent:1:create-instance",
      name: "codex-xmatrix-workstation",
      kind: "agent",
      status: "online",
      mention: "codex-xmatrix-workstation:new",
      action: "create-instance",
    },
  ];

  assert.equal(filterMentionCandidates(candidates, "new")[0].action, "create-instance");
});

test("filterMentionCandidates supports second-level goal command completion", () => {
  const candidates = [
    {
      id: "agent:1",
      name: "codex",
      kind: "agent",
      status: "online",
      mention: "codex:1",
    },
    {
      id: "agent:1:goal-set",
      name: "Set goal",
      kind: "agent",
      status: "online",
      mention: "codex:1 /goal",
      action: "agent-goal-set",
      description: "@codex:1 /goal <goal>",
    },
    {
      id: "agent:1:goal-resume",
      name: "Resume goal",
      kind: "agent",
      status: "online",
      mention: "codex:1 /goal resume",
      action: "agent-goal-resume",
      description: "@codex:1 /goal resume",
    },
    {
      id: "agent:1:goal-status",
      name: "Goal status",
      kind: "agent",
      status: "online",
      mention: "codex:1 /goal status",
      action: "agent-goal-status",
      description: "@codex:1 /goal status",
    },
    {
      id: "agent:1:goal-clear",
      name: "Clear goal",
      kind: "agent",
      status: "online",
      mention: "codex:1 /goal clear",
      action: "agent-goal-clear",
      description: "@codex:1 /goal clear",
    },
  ];

  assert.deepEqual(
    filterMentionCandidates(candidates, "codex:1 /").map((candidate) => candidate.action),
    ["agent-goal-set", "agent-goal-resume", "agent-goal-status", "agent-goal-clear"]
  );
  assert.deepEqual(
    filterMentionCandidates(candidates, "codex:1 /goal c").map((candidate) => candidate.action),
    ["agent-goal-clear"]
  );
  assert.deepEqual(
    filterMentionCandidates(candidates, "codex:1 /goal r").map((candidate) => candidate.action),
    ["agent-goal-resume"]
  );
  assert.deepEqual(
    filterMentionCandidates(candidates, "codex:1 /goal s").map((candidate) => candidate.action),
    ["agent-goal-status"]
  );
});

/** Three online candidates of one kind: `kind:1` … `kind:3`. */
function threeOnline(kind, label) {
  return [1, 2, 3].map((n) => ({ id: `${kind}:${n}`, name: `${label} ${n}`, kind, status: "online" }));
}

function sectionSummary(sections) {
  return sections.map((section) => ({
    label: section.label,
    startIndex: section.startIndex,
    hiddenCount: section.hiddenCount,
    ids: section.candidates.map((candidate) => candidate.id),
  }));
}

test("groupedMentionCandidates separates agent, human, and app candidates with two per section", () => {
  const candidates = [
    ...threeOnline("agent", "Agent"),
    ...threeOnline("user", "Human"),
    ...threeOnline("app", "App"),
  ];

  assert.deepEqual(
    sectionSummary(groupedMentionCandidates(candidates)),
    [
      { label: "Agent", startIndex: 0, hiddenCount: 1, ids: ["agent:1", "agent:2"] },
      { label: "Human", startIndex: 3, hiddenCount: 1, ids: ["user:1", "user:2"] },
      { label: "App", startIndex: 6, hiddenCount: 1, ids: ["app:1", "app:2"] },
    ]
  );
});

test("launch conditions are one section; Auto is listed with the Agents", () => {
  const sections = groupedMentionCandidates([
    { id: "launch:repo:owner/app:", name: "repo:owner/app", kind: "launch", status: "offline" },
    { id: "launch:auto", name: "Auto", kind: "agent", status: "offline" },
  ]);
  assert.deepEqual(sections.map((section) => section.label), ["Condition", "Agent"]);
});

test("groupedMentionCandidates expands selected sections and removes their more row", () => {
  const candidates = [...threeOnline("agent", "Agent"), ...threeOnline("user", "Human")];

  assert.deepEqual(
    sectionSummary(groupedMentionCandidates(candidates, { expandedKinds: ["agent"] })),
    [
      { label: "Agent", startIndex: 0, hiddenCount: 0, ids: ["agent:1", "agent:2", "agent:3"] },
      { label: "Human", startIndex: 3, hiddenCount: 1, ids: ["user:1", "user:2"] },
    ]
  );
});

const defaultListingOptions = {
  openKinds: DEFAULT_OPEN_MENTION_KINDS,
  limitPerKind: DEFAULT_OPEN_MENTION_ROWS,
};

function listingCandidates() {
  const candidates = [
    { id: "service:1", name: "AI 1", kind: "service", status: "online" },
    { id: "service:2", name: "AI 2", kind: "service", status: "online" },
    { id: "user:1", name: "Human 1", kind: "user", status: "online" },
    { id: "user:2", name: "Human 2", kind: "user", status: "online" },
    { id: "app:1", name: "App 1", kind: "app", status: "online" },
  ];
  for (let index = 1; index <= 8; index += 1) {
    candidates.push({ id: `agent:${index}`, name: `Agent ${index}`, kind: "agent", status: "online" });
  }
  return candidates;
}

const sectionShape = (section) => ({
  label: section.label,
  startIndex: section.startIndex,
  hiddenCount: section.hiddenCount,
  ids: section.candidates.map((candidate) => candidate.id),
});

test("the default listing opens Agent and Human and folds the other kinds to one row", () => {
  // A folded kind costs exactly one row no matter how many candidates it has,
  // and an open kind stops at its row budget instead of burying the kind below
  // it — with eight Agents, Human still has to be on screen.
  assert.deepEqual(
    groupedMentionCandidates(listingCandidates(), defaultListingOptions).map(sectionShape),
    [
      { label: "AI service", startIndex: 0, hiddenCount: 2, ids: [] },
      {
        label: "Agent",
        startIndex: 1,
        hiddenCount: 2,
        ids: ["agent:1", "agent:2", "agent:3", "agent:4", "agent:5", "agent:6"],
      },
      { label: "Human", startIndex: 8, hiddenCount: 0, ids: ["user:1", "user:2"] },
      { label: "App", startIndex: 10, hiddenCount: 1, ids: [] },
    ]
  );
});

test("a folded kind opens in full once the human picks its fold row", () => {
  assert.deepEqual(
    groupedMentionCandidates(listingCandidates(), {
      ...defaultListingOptions,
      expandedKinds: ["app", "agent"],
    })
      .filter((section) => section.kind === "agent" || section.kind === "app")
      .map((section) => ({ label: section.label, hiddenCount: section.hiddenCount, shown: section.candidates.length })),
    [
      { label: "Agent", hiddenCount: 0, shown: 8 },
      { label: "App", hiddenCount: 0, shown: 1 },
    ]
  );
});

test("omitting openKinds leaves every kind open, which is what the typed query wants", () => {
  assert.deepEqual(
    groupedMentionCandidates(listingCandidates(), { limitPerKind: 100 }).map((section) => ({
      label: section.label,
      hiddenCount: section.hiddenCount,
      shown: section.candidates.length,
    })),
    [
      { label: "AI service", hiddenCount: 0, shown: 2 },
      { label: "Agent", hiddenCount: 0, shown: 8 },
      { label: "Human", hiddenCount: 0, shown: 2 },
      { label: "App", hiddenCount: 0, shown: 1 },
    ]
  );
});

test("segmented completion shows connector actions only after selecting the connector", () => {
  const channel = openChannel();

  const connectors = [
    {
      id: "github",
      name: "GitHub",
      status: "available",
      actions: [
        {
          id: "subscribe",
          label: "Subscribe issue or PR",
          description: "Link the current channel or thread to an issue or PR",
          completion: {
            trailingDelimiter: ":",
            arguments: {
              id: "github-organization",
              label: "GitHub owner or organization",
              source: "github-organizations",
              trailingDelimiter: "/",
              next: {
                id: "github-repository",
                label: "GitHub repository",
                source: "github-repositories",
                trailingDelimiter: " ",
              },
            },
          },
        },
      ],
    },
  ];
  const root = resolveMentionCompletion("@git", "@git".length, members(channel, []), null, connectors);
  const actions = resolveMentionCompletion(
    "@github:",
    "@github:".length,
    members(channel, []),
    null,
    connectors
  );

  assert.deepEqual(
    root.candidates.map((candidate) => `${candidate.kind}:${candidate.mention}:${candidate.action || "mention"}`),
    ["app:github:mention"]
  );
  assert.equal(actions.stage, "app-action");
  assert.deepEqual(
    actions.candidates.map((candidate) => `${candidate.kind}:${candidate.mention}:${candidate.action}`),
    ["app:github:subscribe:app-command"]
  );
  assert.deepEqual(completeMention("@git", "@git".length, root.candidates[0]), {
    value: "@github:",
    cursor: "@github:".length,
  });
  assert.deepEqual(completeMention("@github:sub", "@github:sub".length, actions.candidates[0]), {
    value: "@github:subscribe:",
    cursor: "@github:subscribe:".length,
  });

  const organizationRequest = resolveMentionCompletion(
    "@github:subscribe:",
    "@github:subscribe:".length,
    members(channel, []),
    null,
    connectors,
    { id: "space-1", members: [] }
  );
  assert.equal(organizationRequest.stage, "app-argument");
  assert.equal(organizationRequest.dynamicRequest.source, "github-organizations");
  assert.deepEqual(organizationRequest.candidates, []);

  const organizations = resolveMentionCompletion(
    "@github:subscribe:lam",
    "@github:subscribe:lam".length,
    members(channel, []),
    null,
    connectors,
    { id: "space-1", members: [] },
    {
      "space-1:channel-1:github:github-organizations:": [
        { id: "lambdalabshq", value: "LambdaLabsHQ", label: "LambdaLabsHQ" },
        { id: "octo", value: "octo", label: "octo" },
      ],
    }
  );
  assert.deepEqual(organizations.candidates.map((candidate) => candidate.mention), [
    "github:subscribe:LambdaLabsHQ",
  ]);
  assert.deepEqual(
    completeMention(
      "@github:subscribe:lam",
      "@github:subscribe:lam".length,
      organizations.candidates[0]
    ),
    {
      value: "@github:subscribe:LambdaLabsHQ/",
      cursor: "@github:subscribe:LambdaLabsHQ/".length,
    }
  );

  const repositories = resolveMentionCompletion(
    "@github:subscribe:LambdaLabsHQ/xm",
    "@github:subscribe:LambdaLabsHQ/xm".length,
    members(channel, []),
    null,
    connectors,
    { id: "space-1", members: [] },
    {
      "space-1:channel-1:github:github-repositories:lambdalabshq": [
        { id: "repo-1", value: "xmatrix", label: "xmatrix", description: "Private repository" },
        { id: "repo-2", value: "website", label: "website" },
      ],
    }
  );
  assert.equal(repositories.dynamicRequest.source, "github-repositories");
  assert.equal(repositories.dynamicRequest.parent, "LambdaLabsHQ");
  assert.deepEqual(repositories.candidates.map((candidate) => candidate.mention), [
    "github:subscribe:LambdaLabsHQ/xmatrix",
  ]);
  assert.deepEqual(
    completeMention(
      "@github:subscribe:LambdaLabsHQ/xm",
      "@github:subscribe:LambdaLabsHQ/xm".length,
      repositories.candidates[0]
    ),
    {
      value: "@github:subscribe:LambdaLabsHQ/xmatrix ",
      cursor: "@github:subscribe:LambdaLabsHQ/xmatrix ".length,
    }
  );
});

test("filterMentionCandidates matches app connector action descriptions", () => {
  const candidates = [
    {
      id: "app:github:subscribe",
      name: "Subscribe issue or PR",
      kind: "app",
      status: "online",
      mention: "github:subscribe",
      action: "app-command",
      description: "Link the current channel or thread to an issue or PR",
    },
  ];

  assert.equal(filterMentionCandidates(candidates, "issue")[0].mention, "github:subscribe");
  assert.equal(filterMentionCandidates(candidates, "connector")[0].kind, "app");
});

test("parseAppMentions parses connector mentions and app actions", () => {
  const connectors = [
    {
      id: "github",
      name: "GitHub",
      status: "available",
      actions: [
        { id: "subscribe", label: "Subscribe issue or PR" },
      ],
    },
    {
      id: "notion",
      name: "Notion",
      status: "planned",
      actions: [{ id: "page_to_context", label: "Page to context" }],
    },
  ];

  assert.deepEqual(parseAppMentions("@github please triage", connectors), [
    {
      token: "@github",
      appId: "github",
      appName: "GitHub",
      status: "available",
      actionId: undefined,
      actionLabel: undefined,
    },
  ]);
  assert.deepEqual(parseAppMentions("@github:subscribe:octo/hello:#42 and @notion:page_to_context", connectors), [
    {
      token: "@github:subscribe",
      appId: "github",
      appName: "GitHub",
      status: "available",
      actionId: "subscribe",
      actionLabel: "Subscribe issue or PR",
    },
    {
      token: "@notion:page_to_context",
      appId: "notion",
      appName: "Notion",
      status: "planned",
      actionId: "page_to_context",
      actionLabel: "Page to context",
    },
  ]);
  assert.deepEqual(parseAppMentions("@github:subscribe:xmatrix:#118", connectors), [
    {
      token: "@github:subscribe",
      appId: "github",
      appName: "GitHub",
      status: "available",
      actionId: "subscribe",
      actionLabel: "Subscribe issue or PR",
    },
  ]);
});

test("completeMention replaces the active @ token at the cursor", () => {
  const draft = "please ask @cod";
  const cursor = draft.length;
  const active = findActiveMention(draft, cursor);

  assert.deepEqual(active, { start: 11, end: 15, tokenEnd: 15, query: "cod" });
  assert.deepEqual(
    completeMention(draft, cursor, {
      id: "agent:1",
      name: "codex-xmatrix-workstation",
      kind: "agent",
      status: "online",
    }),
    {
      value: "please ask @codex-xmatrix-workstation ",
      cursor: 38,
    }
  );
});

test("completeMention can insert a create new instance mention", () => {
  const draft = "please ask @codex-x";
  const cursor = draft.length;
  const active = findActiveMention(draft, cursor);

  assert.deepEqual(active, { start: 11, end: 19, tokenEnd: 19, query: "codex-x" });
  assert.deepEqual(
    completeMention(draft, cursor, {
      id: "agent:1:create-instance",
      name: "codex-xmatrix-workstation",
      kind: "agent",
      status: "online",
      mention: "codex-xmatrix-workstation:new",
      action: "create-instance",
    }),
    {
      value: "please ask @codex-xmatrix-workstation:new ",
      cursor: 42,
    }
  );
});

test("completeMention can insert an instance goal command", () => {
  const draft = "@codex:1 /g";
  const cursor = draft.length;

  assert.deepEqual(findActiveMention(draft, cursor), {
    start: 0,
    end: cursor,
    tokenEnd: cursor,
    query: "codex:1 /g",
  });
  assert.deepEqual(
    completeMention(draft, cursor, {
      id: "agent:1:goal-set",
      name: "Set goal",
      kind: "agent",
      status: "online",
      mention: "codex:1 /goal",
      action: "agent-goal-set",
    }),
    {
      value: "@codex:1 /goal ",
      cursor: 15,
    }
  );
});

test("completeMention preserves human mention display names", () => {
  const draft = "please ask @Yi";
  const cursor = draft.length;

  assert.deepEqual(
    completeMention(draft, cursor, {
      id: "user:1",
      name: "Yiming Hu",
      kind: "user",
      status: "online",
    }),
    {
      value: "please ask @Yiming Hu ",
      cursor: 22,
    }
  );
});

test("findActiveMention keeps inline workspace paths in the active token", () => {
  const draft = "@codex:new:C:\\Users\\dev\\Projects\\xmatrix";
  const cursor = draft.length;

  assert.deepEqual(findActiveMention(draft, cursor), {
    start: 0,
    end: cursor,
    tokenEnd: cursor,
    query: "codex:new:C:\\Users\\dev\\Projects\\xmatrix",
  });
});

test("findActiveMention treats the dismissed completion cursor as inactive", () => {
  assert.equal(findActiveMention("@codex:new:nosuchrepo", -1), null);
});

test("completing from inside the token replaces all of it, not just up to the caret", () => {
  // `@` typed in front of text that was already there leaves the caret in the
  // middle of the token. Replacing only the typed part stranded the tail.
  const draft = "please ask @codex";
  const cursor = draft.indexOf("codex");

  assert.deepEqual(findActiveMention(draft, cursor), {
    start: 11,
    end: 12,
    tokenEnd: draft.length,
    query: "",
  });
  assert.deepEqual(
    completeMention(draft, cursor, {
      id: "agent:1",
      name: "codex-xmatrix-workstation",
      kind: "agent",
      status: "online",
      completionSuffix: ":",
    }),
    { value: "please ask @codex-xmatrix-workstation:", cursor: 38 }
  );
});

test("a start action never inherits the locality of the Agent identity", () => {
  const channel = openChannel();
  const agents = [
    {
      id: "agent:local",
      userId: "user-1",
      name: "codex",
      kind: "agent",
      status: "offline",
      email: "agent@example.com",
      metadata: { hostId: "host-win" },
    },
  ];

  const actions = resolveMentionCompletion(
    "@codex:",
    "@codex:".length,
    members(channel, agents),
    // The viewer sits on the machine this Agent identity is registered to,
    // which is exactly the case that used to stamp every row "local".
    { hostId: "host-win", agentIds: ["agent:local"] },
    [],
    { id: "space-1", members: [] },
    {}
  ).candidates.filter((candidate) => candidate.action === "create-instance");

  assert.deepEqual(
    actions.map((candidate) => candidate.startToken),
    []
  );
  /* Where the Agent is registered is a fact about the identity, not about how
     the instance starts, and the identity row above already carries it. */
  assert.deepEqual([...new Set(actions.map((candidate) => Boolean(candidate.local)))], []);
});

/* The inline Reply-in-thread draft renders against the parent Channel until the
   first reply materializes the thread, so without an explicit scope its picker
   offered the parent's live instances as targets of a message that lands in a
   different Channel. An instance belongs to exactly one Channel: the thread can
   only ever start its own. */
function threadDraftParentChannel() {
  return {
    id: "channel-parent",
    spaceId: "space-1",
    mode: "open",
    memberPresence: {
      "agent:codex": {
        kind: "agent",
        status: "online",
        label: "codex",
        instances: [
          {
            id: "instance-one",
            channelInstanceId: "1",
            label: "codex",
            status: "online",
            connectedAt: "2026-08-16T00:00:00Z",
            lastSeenAt: "2026-08-16T00:00:00Z",
            commands: [{ token: "/stop", label: "Stop", mode: "static" }],
          },
        ],
      },
    },
    createdBy: "user-1",
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
  };
}

const THREAD_DRAFT_AGENTS = [
  { id: "agent:codex", name: "codex", kind: "agent", status: "online" },
];

test("a pending thread draft offers only start actions, never the parent's instances", () => {
  const channel = threadDraftParentChannel();

  const inChannel = resolveMentionCompletion(
    "@codex:",
    "@codex:".length,
    members(channel, THREAD_DRAFT_AGENTS));
  const inPendingThread = resolveMentionCompletion(
    "@codex:",
    "@codex:".length,
    members(channel, THREAD_DRAFT_AGENTS),
    null,
    [],
    null,
    {},
    "none"
  );

  // Same Channel, same presence: only the scope differs.
  assert.deepEqual(
    inChannel.candidates.map((candidate) => candidate.mention),
    ["codex:1", "codex:1:reborn", "codex:1:handoff"]
  );
  assert.deepEqual(
    inPendingThread.candidates.map((candidate) => candidate.mention),
    []
  );
});

test("a pending thread draft resolves no instance commands for a hand-typed ordinal", () => {
  const channel = threadDraftParentChannel();

  const inChannel = resolveMentionCompletion(
    "@codex:1 /",
    "@codex:1 /".length,
    members(channel, THREAD_DRAFT_AGENTS));
  const inPendingThread = resolveMentionCompletion(
    "@codex:1 /",
    "@codex:1 /".length,
    members(channel, THREAD_DRAFT_AGENTS),
    null,
    [],
    null,
    {},
    "none"
  );

  assert.equal(inChannel.stage, "agent-command");
  assert.ok(inChannel.candidates.length > 0);
  // Typing the parent's ordinal by hand must not open its command menu either:
  // the ordinal addresses nothing in the thread the reply will create.
  assert.equal(inPendingThread.stage, "agent-command");
  assert.deepEqual(inPendingThread.candidates, []);
});

test("Agent references describe channel instances without promising a legacy launch", () => {
  const channel = threadDraftParentChannel();

  const inChannel = channelMentionCandidates(members(channel, THREAD_DRAFT_AGENTS));
  const inPendingThread = channelMentionCandidates(
    members(channel, THREAD_DRAFT_AGENTS),
    null,
    [],
    null,
    "none"
  );

  assert.equal(
    inChannel.find((candidate) => candidate.mention === "codex").description,
    "Choose a channel instance"
  );
  assert.equal(
    inPendingThread.find((candidate) => candidate.mention === "codex").description,
    "Agent reference"
  );
});

test("live future controls complete from parameter snapshots and disappear on withdrawal", () => {
  const channel = members({ id: "channel", memberPresence: { a: { kind: "agent", label: "kimi", instances: [{ id: "i", channelInstanceId: "1", status: "online",
    parameters: [{ id: "future-speed", label: "Speed", options: ["turbo", "steady"] }] }] } } }, [{ id: "a", name: "kimi" }]);
  const resolve = query => { const draft = "@" + query; return resolveMentionCompletion(draft, draft.length, channel); };
  const options = resolve("kimi:1 /config future-speed ");
  assert.deepEqual(options.candidates.map(candidate => candidate.name), ["turbo", "steady"]);
  assert.equal(options.candidates[0].mention, "kimi:1 /config future-speed turbo");
  channel.memberPresence.a.instances[0].parameters = [];
  assert.deepEqual(resolve("kimi:1 /config future-speed ").candidates, []);
});

test("parameter completion shows provider labels and descriptions but inserts the value id", () => {
  const channel = members({ id: "channel", memberPresence: { a: { kind: "agent", label: "codex", instances: [{ id: "i", channelInstanceId: "1", status: "online",
    parameters: [{ id: "serviceTier", label: "Service tier", description: "Speed and price", options: ["priority", "default"],
      choices: [{ value: "priority", label: "Fast", description: "1.5x speed" }, { value: "default" }], currentValue: "default", notice: "cooldown" }] }] } } },
  [{ id: "a", name: "codex" }]);
  const resolve = query => { const draft = "@" + query; return resolveMentionCompletion(draft, draft.length, channel); };
  const list = resolve("codex:1 /config ");
  assert.equal(list.candidates[0].description, "default · cooldown · Speed and price");
  const values = resolve("codex:1 /config serviceTier ").candidates;
  assert.deepEqual(values.map(candidate => [candidate.name, candidate.description, candidate.mention]), [
    ["Fast", "1.5x speed", "codex:1 /config serviceTier priority"],
    ["default", "Current", "codex:1 /config serviceTier default"],
  ]);
  assert.deepEqual(resolve("codex:1 /config serviceTier prio").candidates.map(candidate => candidate.name), ["Fast"]);
});

test("composer targets and operations come from interaction descriptors the registry accepts", () => {
  const channel = { id: "channel-1", spaceId: "space-1", mode: "open", memberPresence: {}, createdBy: "user-1",
    createdAt: "2026-05-07T00:00:00Z", updatedAt: "2026-05-07T00:00:00Z" };
  const apps = [{ id: "github", name: "GitHub", status: "available", actions: [
    { id: "create_issue", label: "Create issue" }, { id: "Not An Operation", label: "Broken" }] }];
  const space = { id: "space-1", members: [] };
  const { registry, candidates } = channelInteractionTargets(channel, null, apps, space);
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["app:github"]);
  assert.equal(registry.resolve("xMatrix", "launch").status, "unknown");
  assert.equal(registry.resolve("github", "create_issue").operation.presentationRef, "connector.v1");
  // An action the descriptor cannot declare is not offered as an operation.
  const actions = resolveMentionCompletion("@github:", "@github:".length, channel, null, apps, space);
  assert.equal(actions.stage, "app-action");
  assert.deepEqual(actions.candidates.map((candidate) => candidate.appActionId), ["create_issue"]);
});
