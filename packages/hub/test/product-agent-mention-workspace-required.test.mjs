import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageAuthorityError } from "@xmatrix/db";

import {
  hasProductManagementAgentMention,
  orchestrateProductAgentMentions,
  orchestrateProductChannelAbout,
  orchestrateProductManagementAgentMention,
  orchestrateProductNewConversationStart,
  parseProductHandoffInstanceMentions,
  productSpacePreferredLanguage,
} from "../src/product-agent-mention.ts";
// The mention grammar the Hub executes is the same module the composer completes
// against, so these assertions run directly against the shared definition.
import {
  isAbsoluteLocalPath,
  repoSummonReference,
} from "@xmatrix/protocol";
import {
  parseProductAgentStopCommand,
} from "../src/product-agent-intervention.ts";

function enabledManagementPort(overrides = {}) {
  return basePort({
    async getManagementConfig() { return { enabled: true, sideEffectsEnabled: true, generation: 3 }; },
    ...overrides,
  });
}

function handoffTarget({ channelInstanceId }, overrides = {}) {
  return { instanceId: "ch-1:2", instanceStatus: "online", channelId: "ch-1", channelInstanceId,
    runId: "run-2", runStatus: "running", agentName: "codex", harness: "codex", ownerUserId: "user-1",
    metadata: {}, ...overrides };
}

test("literal lifecycle examples perform no preparation, lookup, stop or spawn", async () => {
  const body = "```\n@codex:new:/tmp/project\n@codex:1:reborn\n@codex:1:handoff:@claude\n```\n\n> @codex:new:/tmp/project";
  const port = new Proxy({}, { get() { assert.fail("literal examples cannot reach an execution port"); } });
  const result = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "literal", body, actorUserId: "user-1", port });
  assert.equal(result.considered, 0);
  assert.equal(result.spawned, 0);
  assert.equal(hasProductManagementAgentMention("`@xmatrix`"), false);
  assert.equal(hasProductManagementAgentMention("> @xmatrix"), false);
  assert.equal(hasProductManagementAgentMention("\\@xmatrix"), false);
  assert.equal(hasProductManagementAgentMention("@xmatrix.example"), false);
  assert.equal(hasProductManagementAgentMention("Please (@xmatrix) inspect"), true);
  for (const command of ["@codex:stop", "/stop all", "xmatrix stop all"]) {
    assert.equal(parseProductAgentStopCommand(`    ${command}`), undefined);
    assert.ok(parseProductAgentStopCommand(`  ${command}`));
  }
});

test("Reborn lookup refusal publishes a visible error instead of rejecting silently", async () => {
  const notices = [];
  const result = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "refused-reborn",
    body: "@codex:1:reborn", actorUserId: "user-1", port: {
      async getRebornTarget() { throw Object.assign(new Error("private diagnostic"), { code: "forbidden" }); },
      async publishSystemNotice(channelId, body) { assert.equal(channelId, "ch-1"); notices.push(body); },
    } });
  assert.equal(result.spawned, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /reborn_target_lookup_failed.*No recovery was queued/);
  assert.equal(notices[0].includes("private diagnostic"), false);
  assert.deepEqual(result.notices, notices);
});

test("a Reborn refusal whose notice cannot be published remains an error", async () => {
  await assert.rejects(orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "refused-reborn-notice",
    body: "@codex:1:reborn", actorUserId: "user-1", port: {
      async getRebornTarget() { return null; },
      async publishSystemNotice() { throw new Error("notice transport unavailable"); },
    } }), /notice transport unavailable/);
});

import {
  dispatchPreparedAgentLaunchWake,
  dispatchProductAgentSystemNotice,
  productAgentSystemNoticeId,
  productAgentSystemNoticeSenderSnapshot,
} from "../src/product-agent-mention-authority-adapter.ts";

test("reserved stop commands do not wake a replacement management delegate", () => {
  assert.equal(hasProductManagementAgentMention("@xMatrix:stop"), false);
  assert.equal(hasProductManagementAgentMention("＠xMatrix:kill maintenance"), false);
  assert.equal(hasProductManagementAgentMention("@xMatrix inspect this channel"), true);
});

test("filesystem paths are never treated as owner/repo summon refs", () => {
  assert.equal(repoSummonReference("/tmp/project"), undefined);
  assert.equal(repoSummonReference("C:\\Users\\dev\\project"), undefined);
  assert.equal(repoSummonReference("./local"), undefined);
  assert.equal(repoSummonReference("LambdaLabsHQ/xmatrix"), "LambdaLabsHQ/xmatrix");
});

test("agent new local-path syntax requires an absolute path", () => {
  assert.equal(isAbsoluteLocalPath("/Users/dev/xmatrix"), true);
  assert.equal(isAbsoluteLocalPath("C:\\Users\\dev\\xmatrix"), true);
  assert.equal(isAbsoluteLocalPath("\\\\server\\share\\xmatrix"), true);
  assert.equal(isAbsoluteLocalPath("./xmatrix"), false);
  assert.equal(isAbsoluteLocalPath("../xmatrix"), false);
  assert.equal(isAbsoluteLocalPath("~/xmatrix"), false);
  assert.equal(isAbsoluteLocalPath("workspace:8ee40ca9"), false);
});

function basePort(overrides = {}) {
  const notices = [];
  const registrationLaunches = [];
  const reborns = [];
  const handoffs = [];
  const port = {
    registrationLaunches,
    reborns,
    handoffs,
    notices,
    async launchRegistrationInput(input) {
      registrationLaunches.push(input);
      return { runId: input.runId ?? `run:${input.commandId}`, instanceId: input.instanceId ?? `instance:${input.commandId}`,
        launchId: `launch:${input.commandId}`, agentName: "codex", hostId: "host-1" };
    },
    async prepareRegisteredReborn(input) {
      reborns.push(input);
      return { intentId: `intent:${input.sourceInstanceId}`, state: "waiting" };
    },
    async prepareRegisteredHandoff(input) {
      handoffs.push(input);
      return { intentId: `intent:handoff:${input.sourceInstanceId}`, state: "waiting" };
    },
    async getChannel() {
      return { id: "ch-1", spaceId: "space-1", mode: "open" };
    },
    async getManagementConfig() {
      return { enabled: false, generation: 0 };
    },
    async getSpacePreferredLanguage() {
      return "en";
    },
    async getRebornTarget() {
      return null;
    },
    async publishSystemNotice(_channelId, body) {
      notices.push(body);
    },
    ...overrides,
  };
  return port;
}

test("system notices are idempotent for one source message and body", async () => {
  const first = await productAgentSystemNoticeId("msg-1", "ch-1", "could not start");
  const replay = await productAgentSystemNoticeId("msg-1", "ch-1", "could not start");
  const changed = await productAgentSystemNoticeId("msg-1", "ch-1", "different notice");

  assert.equal(first, replay);
  assert.notEqual(first, changed);
  assert.match(first, /^system:msg-1:[a-f0-9]{64}$/u);
});

test("system notices carry the trusted xMatrix sender snapshot required by Authority", () => {
  assert.deepEqual(productAgentSystemNoticeSenderSnapshot("user:one@example.com"), {
    identityId: "user:user:one@example.com",
    kind: "user",
    userId: "user:one@example.com",
    email: "user_one_example.com@unknown.invalid",
    label: "xMatrix",
    name: "xMatrix",
    avatarUrl: "/brand/xmatrix-management-icon.png",
  });
});

test("fully rejected PostgreSQL prepare does not wake the Launch coordinator", async () => {
  let touched = false;
  const coordinator = new Proxy({}, {
    get() {
      touched = true;
      throw new Error("empty Launch set must not touch coordinator");
    },
  });
  assert.equal(await dispatchPreparedAgentLaunchWake({
    channels: coordinator,
    channelId: "ch-rejected",
    launchIds: [],
  }), "skipped");
  assert.equal(touched, false);
});

test("prepared PostgreSQL Launch wake goes to its own Channel's coordinator with shard and IDs", async () => {
  const requests = [];
  const coordinator = {
    idFromName(name) {
      assert.equal(name, "ch-1", "one coordinator per Channel, addressed by Channel id");
      return "coordinator-id";
    },
    get(id) {
      assert.equal(id, "coordinator-id");
      return { async fetch(url, init) {
        requests.push({ url, init });
        return new Response(null, { status: 204 });
      } };
    },
  };
  assert.equal(await dispatchPreparedAgentLaunchWake({
    channels: coordinator,
    channelId: "ch-1",
    launchIds: ["launch-1", "launch-2"],
    shardId: "shard-1",
  }), "woken");
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    channelId: "ch-1",
    launchIds: ["launch-1", "launch-2"],
    shardId: "shard-1",
  });
});

test("Agent rejection notice appends through current channel message authority", async () => {
  const appends = [];
  await dispatchProductAgentSystemNotice({
    env: {},
    actorUserId: "user-1",
    sourceMessageId: "msg-rejected",
    channelId: "ch-rejected",
    body: "xMatrix could not start @agent.",
    async append(env, channelId, command) {
      appends.push({ env, channelId, command });
      return { sequence: 1, committedAt: "2026-09-05T00:00:00.000Z" };
    },
  });
  assert.equal(appends.length, 1);
  assert.equal(appends[0].channelId, "ch-rejected");
  assert.equal(appends[0].command.channelId, "ch-rejected");
  assert.equal(appends[0].command.body, "xMatrix could not start @agent.");
  assert.equal(appends[0].command.residual.appMetadata.xmatrixSystemNotice, true);
});

test("a refused system notice carries the message authority's code", async () => {
  await assert.rejects(dispatchProductAgentSystemNotice({
    env: {},
    actorUserId: "user-1",
    sourceMessageId: "msg-archived",
    channelId: "ch-archived",
    body: "Reborn failed.",
    async append() {
      throw new MessageAuthorityError("channel_archived", 409, "Channel is archived");
    },
  }), (error) => error.code === "channel_archived" && /\(409\): Channel is archived/.test(error.message));
});

test("handoff mention parse uses the shared existing-to-new grammar", () => {
  const mentions = parseProductHandoffInstanceMentions(
    "@claude-mba:1:handoff:@grok-daniel-windows continue the lease fix",
  );
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].sourceAgentName, "claude-mba");
  assert.equal(mentions[0].channelInstanceId, 1);
  assert.equal(mentions[0].successorName, "grok-daniel-windows");
  assert.equal(
    parseProductHandoffInstanceMentions("@claude-mba:1:handoff:@grok-daniel-windows:2").length,
    0,
  );
  assert.equal(
    parseProductHandoffInstanceMentions("@grok-daniel-windows:handoff:@claude-mba:1").length,
    0,
  );
});

test("@xMatrix launches a persistent management delegate through Jev, with no configured Agent", async () => {
  const port = basePort({
    async getManagementConfig() {
      return { enabled: true, generation: 3 };
    },
  });
  const result = await orchestrateProductManagementAgentMention({
    channelId: "ch-1",
    messageId: "msg-3",
    body: "@xMatrix check the space",
    actorUserId: "user-1",
    port,
  });
  assert.equal(result.spawned, 1);
  const [launch] = port.registrationLaunches;
  assert.equal(launch.commandId, "management:msg-3");
  assert.equal(Object.hasOwn(launch, "oneshot"), false);
  assert.equal(launch.initialMessageId, "msg-3");
  assert.deepEqual(launch.management, { spaceId: "space-1" });
  assert.deepEqual(launch.coalesce, { routedAs: "management_assistant_mention", configGeneration: 3 });
  assert.deepEqual(launch.runMetadata, { routedAs: "management_assistant_mention",
    managementSpaceId: "space-1", managementConfigGeneration: 3 });
  assert.match(launch.body, /check the space/u);
  assert.match(launch.body, /after removing the @xMatrix mention: check the space$/u);
});

test("@xMatrix reuses the delegate already serving the Channel", async () => {
  const port = basePort({
    async getManagementConfig() {
      return { enabled: true, generation: 3 };
    },
    async launchRegistrationInput() {
      return { runId: "run:live", instanceId: "instance:live", launchId: "", agentName: "codex",
        hostId: "host-1", coalesced: true };
    },
  });
  const result = await orchestrateProductManagementAgentMention({
    channelId: "ch-1", messageId: "msg-4", body: "@xMatrix again", actorUserId: "user-1", port,
  });
  assert.equal(result.spawned, 0);
  assert.equal(result.coalesced, 1);
  assert.deepEqual(result.notices, []);
});

test("@xMatrix reports a disabled Space instead of launching", async () => {
  const port = basePort({
    async getManagementConfig() {
      return { enabled: false, generation: 3 };
    },
  });
  const result = await orchestrateProductManagementAgentMention({
    channelId: "ch-1", messageId: "msg-5", body: "@xMatrix hello", actorUserId: "user-1", port,
  });
  assert.equal(result.spawned, 0);
  assert.equal(port.registrationLaunches.length, 0);
  assert.match(result.notices[0], /management is turned off/u);
});

test("management conversation wakes xMatrix without requiring an @mention", async () => {
  const port = basePort({
    async getManagementConfig() {
      return { enabled: true, managementChannelId: "ch-1", generation: 4 };
    },
  });
  const result = await orchestrateProductManagementAgentMention({
    channelId: "ch-1",
    messageId: "msg-management-conversation",
    body: "What is blocked across the space?",
    actorUserId: "user-1",
    port,
  });

  assert.equal(result.spawned, 1);
  assert.match(port.registrationLaunches[0].body, /What is blocked across the space\?/u);
});

test("@xMatrix runs where the Space prompt's summon says", async () => {
  const port = basePort({
    async getManagementConfig() {
      return { enabled: true, generation: 3, prompt: "@claude effort:high" };
    },
  });
  const result = await orchestrateProductManagementAgentMention({
    channelId: "ch-1", messageId: "msg-prompt", body: "@xMatrix check", actorUserId: "user-1", port,
  });
  assert.equal(result.spawned, 1);
  assert.deepEqual(port.registrationLaunches[0].tags, { harness: "claude", effort: "high" });
});

test("implicit Channel About starts a silent one-shot session through Jev, with no configured Agent", async () => {
  const port = basePort({
    async getManagementConfig() {
      return { enabled: true, sideEffectsEnabled: true, generation: 3, prompt: "@auto harness:codex" };
    },
    async getSpacePreferredLanguage() {
      return "zh";
    },
  });
  const result = await orchestrateProductChannelAbout({
    channelId: "ch-1",
    requestId: "channel-about:ch-1:20",
    triggerMessageId: "m-trigger",
    actorUserId: "user-1",
    port,
  });

  assert.equal(result.spawned, 1);
  assert.equal(port.notices.length, 0, "implicit About work never posts a Channel notice");
  const [launch] = port.registrationLaunches;
  assert.equal(launch.commandId, "about:channel-about:ch-1:20");
  assert.equal(Object.hasOwn(launch, "oneshot"), false);
  assert.deepEqual(launch.aboutSession, { triggerRequestId: "channel-about:ch-1:20", triggerMessageId: "m-trigger", configGeneration: 3 });
  assert.equal(launch.runMetadata.channelAboutTriggerMessageId, "m-trigger");
  assert.match(launch.body, /Task context .*"channelId":"ch-1".*"triggerMessageId":"m-trigger"/);
  assert.match(launch.body, /Other channels, pages, local transcripts, caches/);
  assert.match(launch.body, /--expected-revision/);
  // It reads its own Channel on demand; it never mirrors the Space.
  assert.deepEqual(launch.management, { spaceId: "space-1" });
  assert.match(launch.body, /`xmatrix channel history ch-1 --authoritative`/u);
  assert.match(launch.body, /Write the About to a UTF-8 file, then apply it with `xmatrix channel about ch-1 --summary-file <about file> --through </u);
  assert.deepEqual(launch.tags, { harness: "codex" });
  assert.equal(launch.runMetadata.routedAs, "management_channel_about");
  assert.equal(launch.initialMessageId, undefined);
  assert.match(launch.body, /Always recompute and apply the About/u);
  assert.match(launch.body, /Do not post an acknowledgement/u);
  assert.match(launch.body, /entirely in Simplified Chinese \(zh\)/u);
  assert.match(launch.body, /only source of the About output language/u);
  assert.match(
    launch.body,
    /has been picked up in its thread\. Never describe such a message as unclaimed/u,
    "the About must not call a thread's root unclaimed",
  );
});

test("a conversation's first message names it only while nobody has named it", async () => {
  const run = async (metadata) => {
    const port = basePort({
      async getChannel() { return { id: "ch-1", spaceId: "space-1", mode: "open", metadata }; },
      async getManagementConfig() { return { enabled: true, sideEffectsEnabled: true, generation: 3 }; },
    });
    const result = await orchestrateProductChannelAbout({ channelId: "ch-1", requestId: "channel-about:ch-1:0",
      actorUserId: "user-1", automaticNameOnly: true, port });
    return { result, launches: port.registrationLaunches };
  };
  const named = await run({});
  assert.equal(named.result.spawned, 0, "a conversation a person named waits for the usual cadence");
  assert.equal(named.launches.length, 0);
  const automatic = await run({ autoName: true });
  assert.equal(automatic.result.spawned, 1);
  assert.match(automatic.launches[0].body, /Nobody has named this Channel yet/u);
});

test("implicit Channel About joins the session already serving the Channel", async () => {
  const port = enabledManagementPort({
    async launchRegistrationInput(input) {
      this.registrationLaunches.push(input);
      return { runId: "run:about", instanceId: "session:about", launchId: "", agentName: "codex",
        hostId: "host-1", coalesced: true };
    },
  });
  const result = await orchestrateProductChannelAbout({
    channelId: "ch-1",
    requestId: "channel-about:ch-1:21",
    actorUserId: "user-1",
    port,
  });

  assert.equal(result.spawned, 0);
  assert.equal(result.coalesced, 1);
});

test("a Channel About session that finished its turn is ended by its daemon, not kept", async () => {
  const retired = [{ runId: "run:about-done", channelId: "ch-1", sessionId: "session:done",
    machineOwnerUserId: "owner-1", machineId: "machine-1", hostId: "host-1", executionKey: "execution:done" }];
  const stopped = [];
  const port = enabledManagementPort({
    async launchRegistrationInput(input) {
      this.registrationLaunches.push(input);
      return { runId: "run:about-next", instanceId: "session:next", launchId: "launch-1", agentName: "codex",
        hostId: "host-1", retiredAboutSessions: retired };
    },
    async stopChannelAboutSessions(targets, attempt) { stopped.push(...targets); attempts.push(attempt); },
  });
  const attempts = [];
  const result = await orchestrateProductChannelAbout({
    channelId: "ch-1", requestId: "channel-about:ch-1:23", actorUserId: "user-1", port,
  });

  assert.equal(result.spawned, 1, "the trigger starts a fresh session");
  assert.deepEqual(stopped, retired);
  assert.deepEqual(attempts, ["about:channel-about:ch-1:23"], "each trigger is its own stop attempt");
});

test("a Channel About successor follows its exact predecessor", async () => {
  const port = enabledManagementPort({
  });
  await orchestrateProductChannelAbout({
    channelId: "ch-1", requestId: "channel-about:ch-1:22", successorOfRunId: "run:about-prior",
    actorUserId: "user-1", port,
  });
  const [launch] = port.registrationLaunches;
  assert.equal(launch.commandId, "about-successor:run:about-prior");
  assert.deepEqual(launch.aboutSession, { triggerRequestId: "channel-about:ch-1:22", configGeneration: 3,
    successorOfRunId: "run:about-prior" });
});

test("Channel About language comes only from the explicit Space preference", () => {
  assert.equal(productSpacePreferredLanguage({
    locale: { defaultLocale: "zh-CN", supportedLocales: ["zh-CN", "en"] },
    preferredLanguage: "en",
  }), "zh", "the versioned Space policy takes precedence");
  assert.equal(productSpacePreferredLanguage({ preferredLanguage: "en" }), "en");
  assert.equal(productSpacePreferredLanguage({ locale: { defaultLocale: "fr" } }), "en");
  assert.equal(productSpacePreferredLanguage({ name: "中文频道", messages: ["English"] }), "en");
});

test("implicit Channel About uses the stable Space default without inferring from Channel content", async () => {
  const port = enabledManagementPort({
  });
  const result = await orchestrateProductChannelAbout({
    channelId: "ch-1",
    requestId: "channel-about:ch-1:25",
    actorUserId: "user-1",
    port,
  });

  assert.equal(result.spawned, 1);
  assert.match(port.registrationLaunches[0].body, /entirely in English \(en\)/u);
  assert.match(port.registrationLaunches[0].body, /only source of the About output language/u);
  assert.equal(port.notices.length, 0, "missing language remains silent in the Channel");
});

test("a reborn mention prepares a registration reborn of the addressed Instance", async () => {
  const port = basePort({
    async getRebornTarget({ agentName, channelInstanceId }) {
      assert.equal(agentName, "codex");
      return { instanceId: "ch-1:1", instanceStatus: "online", channelId: "ch-1", channelInstanceId,
        runId: "run-1", runStatus: "running", agentName: "Codex", harness: "codex", ownerUserId: "user-1",
        metadata: {} };
    },
  });
  const result = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-1",
    body: "@codex:1:reborn continue", actorUserId: "user-1", port });
  assert.equal(result.spawned, 1);
  assert.deepEqual(port.reborns.map(({ sourceInstanceId, sourceMention }) => ({ sourceInstanceId, sourceMention })),
    [{ sourceInstanceId: "ch-1:1", sourceMention: "@codex:1:reborn" }]);
  assert.equal(port.registrationLaunches.length, 0);
});

test("a refused registration reborn names its code in the Channel", async () => {
  const port = basePort({
    async getRebornTarget({ channelInstanceId }) {
      return { instanceId: "ch-1:1", instanceStatus: "offline", channelId: "ch-1", channelInstanceId,
        runId: "run-1", runStatus: "stopped", agentName: "codex", harness: "codex", ownerUserId: "user-1",
        metadata: {} };
    },
    async prepareRegisteredReborn() {
      throw Object.assign(new Error("refused"), { code: "registration_reborn_unregistered" });
    },
  });
  const result = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-2",
    body: "@codex:1:reborn", actorUserId: "user-1", port });
  assert.equal(result.spawned, 0);
  assert.equal(port.notices.length, 1);
  assert.match(port.notices[0], /registration_reborn_unregistered.*No recovery was queued/);
});

test("a handoff hands the source's directory to the named harness through its registration", async () => {
  const port = basePort({
    async getRebornTarget(input) {
      return handoffTarget(input, { workspace: { machineId: "machine-1", canonicalCwd: "/tmp/project" }, metadata: { runtime: "codex" } });
    },
  });
  const result = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-3",
    body: "@codex:2:handoff:@claude finish the refactor", actorUserId: "user-1", port });
  assert.equal(result.spawned, 1);
  assert.equal(port.handoffs.length, 1);
  const [handoff] = port.handoffs;
  assert.equal(handoff.sourceInstanceId, "ch-1:2");
  assert.equal(handoff.successorHarness, "claude");
  assert.equal(handoff.sourceMention, "@codex:2:handoff:@claude");
  assert.match(handoff.prompt, /Inherited working directory: \/tmp\/project/);
  assert.match(handoff.prompt, /finish the refactor/);
});

test("a refused handoff names its code in the Channel", async () => {
  const port = basePort({
    getRebornTarget: handoffTarget,
    async prepareRegisteredHandoff() {
      throw Object.assign(new Error("refused"), { code: "registration_not_found" });
    },
  });
  const result = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-4",
    body: "@codex:2:handoff:@grok", actorUserId: "user-1", port });
  assert.equal(result.spawned, 0);
  assert.match(port.notices[0], /could not hand off @codex:2 to @grok \(registration_not_found\)/);
});

function repoSource(overrides = {}) {
  return async ({ channelInstanceId }) => ({ instanceId: "ch-1:2", instanceStatus: "online", channelId: "ch-1",
    channelInstanceId, runId: "run-2", runStatus: "running", agentName: "claude", harness: "claude",
    ownerUserId: "user-1", workspace: { machineId: "machine-1", canonicalCwd: "/repo" },
    metadata: { runtime: "claude", remoteRepo: "acme/app" }, ...overrides });
}

test("a handoff to the source's own harness moves to another machine through the repository", async () => {
  const elsewhere = [];
  const port = basePort({
    getRebornTarget: repoSource(),
    async prepareRegisteredHandoff() { throw Object.assign(new Error("same"), { code: "handoff_same_agent" }); },
    async handOffElsewhere(input) { elsewhere.push(input); return { agentName: "claude" }; },
  });
  const result = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-5",
    body: "@claude:2:handoff:@claude keep going", actorUserId: "user-1", port });
  assert.equal(result.spawned, 1);
  assert.deepEqual(port.notices, []);
  assert.equal(elsewhere.length, 1);
  const [handoff] = elsewhere;
  assert.match(handoff.commandId, /^handoff-elsewhere:[0-9a-f]{64}$/u);
  assert.deepEqual({ ...handoff, commandId: undefined }, { commandId: undefined, actorUserId: "user-1", channelId: "ch-1",
    sourceMessageId: "m-5", sourceRunId: "run-2", sourceInstanceId: "ch-1:2", sourceAddress: "@claude:2",
    repository: "acme/app", harness: "claude", request: "keep going",
    sourceMention: "@claude:2:handoff:@claude" });
});

test("@auto takes a same-machine successor when there is one, and any machine otherwise", async () => {
  const autos = [], elsewhere = [];
  const port = (outcome) => basePort({
    getRebornTarget: repoSource(),
    async prepareRegisteredAutoHandoff(input) { autos.push(input); return outcome; },
    async handOffElsewhere(input) { elsewhere.push(input); return { agentName: "codex" }; },
  });
  const here = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-6",
    body: "@claude:2:handoff:@auto", actorUserId: "user-1",
    port: port({ outcome: "handed_off", successorHarness: "codex" }) });
  assert.equal(here.spawned, 1);
  assert.equal(autos[0].sourceMention, "@claude:2:handoff:@auto");
  assert.match(autos[0].prompt, /Inherited working directory: \/repo/);
  assert.equal(elsewhere.length, 0);

  const away = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-7",
    body: "@claude:2:handoff:@auto", actorUserId: "user-1",
    port: port({ outcome: "no_successor", repository: "acme/app" }) });
  assert.equal(away.spawned, 1);
  assert.equal(elsewhere.length, 1);
  assert.equal(elsewhere[0].harness, undefined, "routing picks the harness");
  assert.equal(elsewhere[0].repository, "acme/app");
  assert.equal(elsewhere[0].sourceMention, "@claude:2:handoff:@auto");
});

test("a handoff that cannot leave its machine says why, once", async () => {
  for (const [body, overrides, code] of [
    ["@claude:2:handoff:@codex", { getRebornTarget: repoSource({ metadata: { runtime: "claude" } }),
      async prepareRegisteredHandoff() { throw Object.assign(new Error("none"), { code: "registration_not_found" }); } },
    "registration_not_found"],
    ["@claude:2:handoff:@codex", { getRebornTarget: repoSource(),
      async prepareRegisteredHandoff() { throw Object.assign(new Error("pending"), { code: "reborn_pending" }); } },
    "reborn_pending"],
    ["@claude:2:handoff:@auto", { getRebornTarget: repoSource(),
      async prepareRegisteredAutoHandoff() { return { outcome: "no_successor" }; } }, "handoff_no_successor"],
    ["@claude:2:handoff:@codex", { getRebornTarget: repoSource(),
      async prepareRegisteredHandoff() { throw Object.assign(new Error("same"), { code: "registration_not_found" }); },
      async handOffElsewhere() { throw Object.assign(new Error("none"), { code: "registration_no_candidate" }); } },
    "registration_no_candidate"],
  ]) {
    const elsewhere = [];
    const port = basePort({ async handOffElsewhere(input) { elsewhere.push(input); return { agentName: "x" }; },
      ...overrides });
    const result = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-8", body,
      actorUserId: "user-1", port });
    assert.equal(result.spawned, 0, body);
    assert.equal(port.notices.length, 1);
    assert.match(port.notices[0], new RegExp(`could not hand off @claude:2 to @\\w+ \\(${code}\\)`, "u"));
  }
});

test("a new conversation's first message asks Jev which harness to summon and a no summons nothing", async () => {
  const decisions = [];
  const diagnostics = [];
  const port = (autoName, outcome) => ({
    async getChannel(id) { return { id, spaceId: "space-1", mode: "open", metadata: autoName ? { autoName: true } : {} }; },
    async decideFirstMessageLaunch(decision) {
      decisions.push(decision);
      if (typeof outcome === "string") throw Object.assign(new Error(outcome), { code: outcome });
      return outcome ?? { claimed: true, harness: "codex" };
    },
    async launchRegistrationInput() { throw new Error("a first message never launches directly"); },
    reportDiagnostic(value) { diagnostics.push(value); },
  });
  const input = { channelId: "ch-1", messageId: "m-1", body: "fix the flaky login test" };

  assert.deepEqual(await orchestrateProductNewConversationStart({ ...input, port: port(false) }), {});
  assert.equal(decisions.length, 0, "a named conversation is not a new one");

  assert.deepEqual(await orchestrateProductNewConversationStart({ ...input, port: port(true) }), { harness: "codex" });
  assert.deepEqual(decisions[0], { channelId: "ch-1", messageId: "m-1", body: input.body, window: false });

  // Jev's "no", or the author's own pick winning the window, summons nothing here.
  assert.deepEqual(await orchestrateProductNewConversationStart({ ...input, port: port(true, { claimed: true }) }), {});
  assert.deepEqual(await orchestrateProductNewConversationStart({ ...input, authorKind: "user",
    port: port(true, { claimed: false }) }), {});
  assert.equal(decisions.at(-1).window, true, "a Human's first message gives its author the window");
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(await orchestrateProductNewConversationStart({ ...input, port: port(true, "registration_not_found") }), {});
  assert.deepEqual(diagnostics.map(value => value.error), ["registration_not_found"]);
});
