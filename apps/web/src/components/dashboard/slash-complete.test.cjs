const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  channelSlashCommands,
  completeSlashCommandTarget,
  completeSlashCommandToken,
  filterSlashCommands,
  findActiveSlashCommand,
  resolveSlashCompletion,
} = require("./slash-complete.ts");

// The slash path's output is the mention path's input: what it composes must be
// something the existing `@instance /command` stage still understands.
const { resolveMentionCompletion } = require("./mention-complete.ts");

const CLAUDE_MODELS = [
  {
    id: "opus",
    model: "claude-opus-5",
    displayName: "Opus 5",
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "low" }],
  },
];

function instance(overrides) {
  return {
    id: "instance-1",
    channelInstanceId: "1",
    channelId: "channel-1",
    label: "claude-code",
    status: "online",
    connectedAt: "2026-08-16T00:00:00Z",
    lastSeenAt: "2026-08-16T00:00:00Z",
    ...overrides,
  };
}

function agent(overrides) {
  return {
    id: "agent:1",
    userId: "user-1",
    name: "claude-code",
    type: "claude-code",
    email: "claude@example.com",
    metadata: {},
    connectedAt: "2026-08-16T00:00:00Z",
    lastSeenAt: "2026-08-16T00:00:00Z",
    status: "online",
    ...overrides,
  };
}

/** Two agents in one channel: one advertises commands, one predates that. */
function twoAgentChannel() {
  const claude = agent({});
  const codex = agent({ id: "agent:2", name: "codex", type: "codex", email: "codex@example.com" });
  const channel = {
    id: "channel-1",
    spaceId: "space-1",
    mode: "open",
    createdBy: "user-1",
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
    memberPresence: {
      "agent:1": {
        kind: "agent",
        status: "online",
        label: "claude-code",
        instances: [
          instance({
            models: CLAUDE_MODELS,
            model: "claude-opus-5",
            commands: [
              { token: "/model", label: "Switch model", mode: "typed", argumentSource: "agent-models" },
              { token: "/effort", label: "Switch effort", mode: "typed", argumentSource: "agent-efforts" },
              { token: "/compact", label: "Compact context", mode: "passthrough" },
              { token: "no-slash", label: "Not a command" },
            ],
          }),
        ],
      },
      "agent:2": {
        kind: "agent",
        status: "online",
        label: "codex",
        instances: [
          instance({
            id: "instance-2",
            channelInstanceId: "2",
            label: "codex",
            models: CLAUDE_MODELS,
            model: "claude-opus-5",
            capabilities: ["goal", "goal.set", "goal.get"],
          }),
        ],
      },
    },
  };
  return { channel, agents: [claude, codex] };
}

test("findActiveSlashCommand only claims a draft that starts with a slash", () => {
  assert.equal(findActiveSlashCommand("/mod", 4)?.stage, "command");
  assert.equal(findActiveSlashCommand("/mod", 4)?.query, "mod");
  assert.equal(findActiveSlashCommand("  /mod", 6)?.start, 2);
  // Mid-sentence slashes are slashes, not commands.
  assert.equal(findActiveSlashCommand("ship it /now", 12), null);
  assert.equal(findActiveSlashCommand("a/b", 3), null);
  // The mention stage still owns the command it already anchors.
  assert.equal(findActiveSlashCommand("@claude-code:1 /mod", 19), null);
});

test("findActiveSlashCommand parses the target stage after a chosen command", () => {
  const active = findActiveSlashCommand("/model @cl", 10);
  assert.equal(active.stage, "target");
  assert.equal(active.token, "/model");
  assert.equal(active.query, "cl");
  assert.equal(active.start, 0);
});

test("findActiveSlashCommand closes once free-form text follows the command", () => {
  // `/goal ship the thing` is a goal body being typed, not a target query.
  assert.equal(findActiveSlashCommand("/goal ship the", 14), null);
});

test("channelSlashCommands unions every live instance's commands, deduped by token", () => {
  const { channel } = twoAgentChannel();
  const commands = channelSlashCommands(channel);

  assert.deepEqual(
    commands.map((command) => command.token),
    ["/compact", "/effort", "/goal", "/model"]
  );

  // Advertised and built-in sources both reach `/model`, so it is one row with
  // two runners — that is exactly the choice the target stage then offers.
  const model = commands.find((command) => command.token === "/model");
  assert.deepEqual(
    model.targets.map((target) => target.mention),
    ["claude-code:1", "codex:2"]
  );
  // A token without a leading slash is not a command and never becomes a row.
  assert.equal(
    commands.some((command) => command.token.includes("no-slash")),
    false
  );
  // `/compact` is advertised by Claude only; `/goal` is the built-in fallback
  // that only the runtime without advertised commands contributes.
  assert.deepEqual(
    commands.find((command) => command.token === "/compact").targets.map((t) => t.mention),
    ["claude-code:1"]
  );
  assert.deepEqual(
    commands.find((command) => command.token === "/goal").targets.map((t) => t.mention),
    ["codex:2"]
  );
});

test("channelSlashCommands ranks the instance on this machine first", () => {
  const { channel } = twoAgentChannel();
  channel.memberPresence["agent:2"].instances[0].hostName = "Devs-MacBook-Pro.local";
  channel.memberPresence["agent:2"].instances[0].machineId = "machine:local";
  const commands = channelSlashCommands(channel, {
    machineId: "machine:local",
  });
  const model = commands.find((command) => command.token === "/model");
  assert.deepEqual(
    model.targets.map((target) => `${target.mention}:${target.local}`),
    ["codex:2:true", "claude-code:1:false"]
  );
});

test("channelSlashCommands never ranks a matching hostname as local without identity", () => {
  const { channel } = twoAgentChannel();
  channel.memberPresence["agent:2"].instances[0].hostName = "Devs-MacBook-Pro.local";
  const model = channelSlashCommands(channel, { hostName: "Devs-MacBook-Pro.local" })
    .find(command => command.token === "/model");
  assert.ok(model.targets.every(target => target.local === false));
});

test("channelSlashCommands is empty without a channel", () => {
  assert.deepEqual(channelSlashCommands(null), []);
});

test("filterSlashCommands narrows by token, label, and description", () => {
  const { channel } = twoAgentChannel();
  const commands = channelSlashCommands(channel);
  assert.deepEqual(
    filterSlashCommands(commands, "mod").map((command) => command.token),
    ["/model"]
  );
  assert.deepEqual(
    filterSlashCommands(commands, "switch").map((command) => command.token),
    ["/effort", "/model"]
  );
  assert.equal(filterSlashCommands(commands, "").length, commands.length);
});

test("resolveSlashCompletion opens the command stage, then the target stage", () => {
  const { channel } = twoAgentChannel();

  const commandStage = resolveSlashCompletion("/mo", 3, channel);
  assert.equal(commandStage.stage, "command");
  assert.deepEqual(
    commandStage.commands.map((command) => command.token),
    ["/model"]
  );
  assert.deepEqual(commandStage.targets, []);

  const targetStage = resolveSlashCompletion("/model @", 8, channel);
  assert.equal(targetStage.stage, "target");
  assert.equal(targetStage.command.token, "/model");
  assert.deepEqual(
    targetStage.targets.map((target) => target.mention),
    ["claude-code:1", "codex:2"]
  );

  const narrowed = resolveSlashCompletion("/model @codex", 13, channel);
  assert.deepEqual(
    narrowed.targets.map((target) => target.mention),
    ["codex:2"]
  );
});

test("resolveSlashCompletion offers nothing for a token no instance accepts", () => {
  const { channel } = twoAgentChannel();
  const result = resolveSlashCompletion("/deploy @", 9, channel);
  assert.equal(result.command, null);
  assert.deepEqual(result.targets, []);
});

test("completeSlashCommandToken opens the target stage without damaging the draft", () => {
  const next = completeSlashCommandToken("/mo", 3, "/model");
  assert.equal(next.value, "/model @");
  assert.equal(next.cursor, next.value.length);

  // Typing `@` in front of text that was already there replaces the whole
  // expression rather than leaving an orphan tail.
  const overTail = completeSlashCommandToken("/moX", 3, "/model");
  assert.equal(overTail.value, "/model @");
});

test("completeSlashCommandTarget composes the mention grammar the Hub parses", () => {
  const { channel } = twoAgentChannel();
  const next = completeSlashCommandTarget("/model @cl", 10, "/model", "claude-code:1");
  assert.equal(next.value, "@claude-code:1 /model ");
  assert.equal(next.cursor, next.value.length);

  // And the mention path picks the composed text straight up: the argument
  // stage for `/model` opens with this instance's reported models.
  const handoff = resolveMentionCompletion(next.value, next.cursor, channel);
  assert.equal(handoff.stage, "agent-model");
  assert.deepEqual(
    handoff.candidates.map((candidate) => candidate.mention),
    ["claude-code:1 /model claude-opus-5"]
  );
});

test("completeSlashCommandTarget keeps trailing text and adds no double space", () => {
  const next = completeSlashCommandTarget("/model @cl then ship", 10, "/model", "claude-code:1");
  assert.equal(next.value, "@claude-code:1 /model then ship");
  assert.equal(next.cursor, "@claude-code:1 /model ".length - 1);
});

test("a one-runner command still composes the same text without a target stage", () => {
  const { channel } = twoAgentChannel();
  const compact = channelSlashCommands(channel).find(
    (command) => command.token === "/compact"
  );
  assert.equal(compact.targets.length, 1);

  const next = completeSlashCommandTarget("/compact", 8, compact.token, compact.targets[0].mention);
  assert.equal(next.value, "@claude-code:1 /compact ");

  // The composed text is a mention the existing stage recognizes as a command.
  const handoff = resolveMentionCompletion(next.value, next.value.length - 1, channel);
  assert.equal(handoff.stage, "agent-command");
  assert.equal(
    handoff.candidates.some((candidate) => candidate.mention === "claude-code:1 /compact"),
    true
  );
});

test("the slash palette leaves an existing mention's command stage alone", () => {
  const { channel } = twoAgentChannel();
  const draft = "@claude-code:1 /compa";
  assert.equal(findActiveSlashCommand(draft, draft.length), null);

  const mention = resolveMentionCompletion(draft, draft.length, channel);
  assert.equal(mention.stage, "agent-command");
  assert.deepEqual(
    mention.candidates.map((candidate) => candidate.mention),
    ["claude-code:1 /compact"]
  );
});

/**
 * A registration-launched Run has no Space Agent Profile: the Channel keys its
 * member by the Instance, and the completion agent list does not contain it.
 */
function registrationChannel() {
  const commands = [
    { token: "/model", label: "Switch model", mode: "typed", argumentSource: "agent-models" },
    { token: "/compact", label: "Compact context", mode: "passthrough" },
  ];
  return {
    id: "channel-r",
    spaceId: "space-1",
    mode: "open",
    createdBy: "user-1",
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
    memberPresence: {
      "channel-r:1": {
        kind: "agent",
        label: "claude",
        instances: [instance({ id: "channel-r:1", channelId: "channel-r", label: "claude:1", models: CLAUDE_MODELS, commands })],
      },
      "channel-r:2": {
        kind: "agent",
        label: "claude",
        instances: [instance({
          id: "channel-r:2", channelInstanceId: "2", channelId: "channel-r", label: "claude:2", commands,
        })],
      },
    },
  };
}

test("a registration Run with no Profile still offers its slash commands", () => {
  const channel = registrationChannel();
  const commands = channelSlashCommands(channel, null);
  assert.deepEqual(commands.map((command) => command.token), ["/compact", "/model"]);
  const compact = commands.find((command) => command.token === "/compact");
  assert.deepEqual(compact.targets.map((target) => target.mention).sort(), ["claude:1", "claude:2"]);
});

test("a registration Run's `@instance /` stage lists its commands", () => {
  const channel = registrationChannel();
  const draft = "@claude:2 /";
  const result = resolveMentionCompletion(draft, draft.length, channel, null);
  assert.equal(result.stage, "agent-command");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.mention),
    ["claude:2 /model", "claude:2 /compact"]
  );
});
