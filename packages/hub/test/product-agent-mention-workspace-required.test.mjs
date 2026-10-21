import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageAuthorityError } from "@xmatrix/db";

import {
  orchestrateProductAgentMentions,
  orchestrateProductNewConversationStart,
  parseProductHandoffInstanceMentions,
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
  // The retired management agent: an @xMatrix mention reaches no execution port either.
  for (const retired of ["@xMatrix check the space", "Please (@xmatrix) inspect", "@xMatrix:stop"]) {
    const ignored = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "xmatrix", body: retired,
      actorUserId: "user-1", port });
    assert.deepEqual(ignored, { considered: 0, spawned: 0, notices: [] }, retired);
  }
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
      async recordResult(channelId, body) { assert.equal(channelId, "ch-1"); notices.push(body); },
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
      async recordResult() { throw new Error("notice transport unavailable"); },
    } }), /notice transport unavailable/);
});

import {
  dispatchPreparedAgentLaunchWake,
  dispatchProductAgentSystemNotice,
  productAgentSystemNoticeId,
  productAgentSystemNoticeSenderSnapshot,
} from "../src/product-agent-mention-authority-adapter.ts";

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
  const reborns = [];
  const handoffs = [];
  const port = {
    reborns,
    handoffs,
    notices,
    async prepareRegisteredReborn(input) {
      reborns.push(input);
      return { intentId: `intent:${input.sourceInstanceId}`, state: "waiting" };
    },
    async handOff(input) {
      handoffs.push(input);
      return { agentName: input.harness ?? "codex" };
    },
    async getChannel() {
      return { id: "ch-1", spaceId: "space-1", mode: "open" };
    },
    async getRebornTarget() {
      return null;
    },
    async recordResult(_channelId, body) {
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
    // The event names its work: the pass runs Launch work and whatever else is due.
    work: ["launch"],
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

function repoSource(overrides = {}) {
  return async ({ channelInstanceId }) => ({ instanceId: "ch-1:2", instanceStatus: "online", channelId: "ch-1",
    channelInstanceId, runId: "run-2", runStatus: "running", agentName: "claude", harness: "claude",
    ownerUserId: "user-1", workspace: { machineId: "machine-1", canonicalCwd: "/repo" },
    metadata: { runtime: "claude", remoteRepo: "acme/app" }, ...overrides });
}

test("a named handoff is an ordinary launch of that harness through the source's repository", async () => {
  // The named harness may be the source's own: the same harness elsewhere is eligible.
  for (const [body, harness] of [["@claude:2:handoff:@codex keep going", "codex"], ["@claude:2:handoff:@claude keep going", "claude"]]) {
    const port = basePort({ getRebornTarget: repoSource() });
    const result = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-5", body,
      actorUserId: "user-1", port });
    assert.equal(result.spawned, 1);
    assert.deepEqual(port.notices, []);
    const [handoff] = port.handoffs;
    assert.match(handoff.commandId, /^handoff-elsewhere:[0-9a-f]{64}$/u);
    assert.deepEqual({ ...handoff, commandId: undefined }, { commandId: undefined, actorUserId: "user-1", channelId: "ch-1",
      sourceMessageId: "m-5", sourceRunId: "run-2", sourceInstanceId: "ch-1:2", sourceAddress: "@claude:2",
      repository: "acme/app", harness, request: "keep going", sourceMention: body.split(" ")[0] });
  }
});

test("@auto leaves the harness to routing, with no same-machine preference", async () => {
  const port = basePort({ getRebornTarget: repoSource() });
  const result = await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-6",
    body: "@claude:2:handoff:@auto", actorUserId: "user-1", port });
  assert.equal(result.spawned, 1);
  assert.equal(port.handoffs[0].harness, undefined, "routing picks the harness");
  assert.equal(port.handoffs[0].repository, "acme/app");
  assert.equal(port.handoffs[0].sourceMention, "@claude:2:handoff:@auto");
});

test("a source without a repository hands off its registered directory, or none for a managed one", async () => {
  for (const [workspace, metadata, site] of [
    [{ machineId: "machine-1", canonicalCwd: "/srv/notes" }, { runtime: "codex" }, { directory: "/srv/notes" }],
    [{ machineId: "machine-1", canonicalCwd: "/home/u/.xmatrix-managed/k" }, { managedWorkspaceKey: "k" }, {}],
  ]) {
    const port = basePort({ getRebornTarget: input => handoffTarget(input, { workspace, metadata }) });
    await orchestrateProductAgentMentions({ channelId: "ch-1", messageId: "m-3",
      body: "@codex:2:handoff:@claude finish the refactor", actorUserId: "user-1", port });
    const [handoff] = port.handoffs;
    assert.equal(handoff.repository, site.repository);
    assert.equal(handoff.directory, site.directory);
    assert.equal(handoff.harness, "claude");
    assert.equal(handoff.request, "finish the refactor");
  }
});

test("a handoff that cannot start says why, once", async () => {
  for (const [body, overrides, code] of [
    ["@claude:2:handoff:@codex", { getRebornTarget: repoSource({ metadata: { routedAs: "management_space" } }) },
      "handoff_source_not_transferable"],
    ["@claude:2:handoff:@codex", { getRebornTarget: repoSource(),
      async handOff() { throw Object.assign(new Error("none"), { code: "registration_quota_exhausted" }); } },
    "registration_quota_exhausted"],
    ["@claude:2:handoff:@codex", { getRebornTarget: repoSource(),
      async handOff() { throw new Error("transport"); } }, "registration_handoff_failed"],
  ]) {
    const port = basePort(overrides);
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

test("page and message discussions use the first-message choice despite their passage title", async () => {
  const body = "> Fill Pantry\n\n— [Fill Pantry › Fill Pantry](https://xmatrix.sh/app/space/pages?page=page-1)\n\n这个项目是怎么决策要做的";
  const decisions = [];
  for (const metadata of [
    { fromPageId: "page-1" },
    { fromChannelId: "source-channel", fromMessageId: "source-message" },
  ]) {
    const port = {
      async getChannel(id) { return { id, name: "“Fill Pantry”", metadata }; },
      async decideFirstMessageLaunch(input) { decisions.push(input); return { claimed: true, harness: "codex" }; },
    };
    assert.deepEqual(await orchestrateProductNewConversationStart({ channelId: "discussion", messageId: "first",
      body, authorKind: "user", port }), { harness: "codex" });
    assert.deepEqual(decisions.at(-1), { channelId: "discussion", messageId: "first", body, window: true });
  }
  assert.equal(decisions.length, 2);

  // A title alone, malformed origin, archived Channel, or empty draft is not a discussion launch.
  for (const channel of [null, { metadata: {} }, { metadata: { fromPageId: true } },
    { metadata: { fromPageId: " " } }, { metadata: { fromMessageId: "source-message" } },
    { metadata: { fromChannelId: "source-channel" } },
    { archivedAt: "2026-10-19T00:00:00Z", metadata: { fromPageId: "page-1" } }]) {
    assert.deepEqual(await orchestrateProductNewConversationStart({ channelId: "discussion", messageId: "first",
      body, authorKind: "user", port: { async getChannel() { return channel; },
        async decideFirstMessageLaunch() { assert.fail("ineligible Channel must not ask Jev"); } } }), {});
  }
  assert.deepEqual(await orchestrateProductNewConversationStart({ channelId: "discussion", messageId: "first",
    body: " \n ", authorKind: "user", port: { async getChannel() { return { metadata: { fromPageId: "page-1" } }; },
      async decideFirstMessageLaunch() { assert.fail("empty draft must not ask Jev"); } } }), {});
});
