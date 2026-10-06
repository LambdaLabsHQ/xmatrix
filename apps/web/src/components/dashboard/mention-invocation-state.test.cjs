const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const {
  summonView, invocationPollInterval, invocationVendorIcon, splitMentionRejections,
  continuationView, splitMentionContinuations, splitHandoffMentions, handoffView,
  handoffSuccessorLaunch, segmentMessageInteraction,
} = require("./mention-invocation-state.ts");

const at = "2026-09-12T15:31:05.470Z";
const base = { launchId: "launch:one", sourceMessageId: "message:one", channelId: "channel:one",
  targetName: "codex", launchKind: "agent_mention_spawn",
  sourceMention: "@codex:new:owner/repo", runId: "run:one", instanceId: "instance:one",
  state: "connected", attempt: 0, retryable: false, createdAt: at, updatedAt: at, connectedAt: at };
const step = (view, label) => view.steps.find(entry => entry.label === label);
test("a summon chip leads with the harness vendor icon", () => {
  assert.equal(invocationVendorIcon({ sourceMention: "@grok machine:Workstation", targetName: "grok" }),
    "/agent-vendors/grok.svg");
  assert.equal(invocationVendorIcon({ sourceMention: "@auto machine:Workstation harness:codex", targetName: "Agent" }),
    "/agent-vendors/openai.svg");
  assert.equal(invocationVendorIcon({
    sourceMention: "@auto machine:Workstation", targetName: "Reviewer",
    routingDecision: { rows: [{ harness: "claude", selected: true }] },
  }), "/agent-vendors/claude.svg");
  // The bound registration's mark wins once the launch carries it.
  assert.equal(invocationVendorIcon({
    sourceMention: "@grok machine:Workstation", targetAvatarUrl: "/agent-vendors/grok.svg",
  }), "/agent-vendors/grok.svg");
  assert.equal(invocationVendorIcon({ sourceMention: "@auto machine:Workstation", targetName: "Agent" }), undefined);
  assert.equal(invocationVendorIcon({ sourceMention: "@auto harness:agent", targetName: "Agent" }),
    "/agent-vendors/cursor.png");
  assert.equal(invocationVendorIcon({ sourceMention: "@auto harness:cursor-agent", targetName: "Agent" }),
    "/agent-vendors/cursor.png");
  // Read with the launch grammar: `harness:` after prose is not a condition.
  assert.equal(invocationVendorIcon({ sourceMention: "@auto review harness:codex", targetName: "Agent" }), undefined);
  assert.equal(invocationVendorIcon({ sourceMention: '@auto harness:"claude_code"', targetName: "Agent" }),
    "/agent-vendors/claude.svg");
});
test("a summon lists every step on one level", () => {
  const chosen = summonView({ ...base, routingDecision: { source: "jev", evaluatedAt: "2026-09-22T18:00:00Z" } });
  assert.deepEqual(chosen.steps.map(entry => entry.label), [
    "Jev selected an environment", "Machine accepted", "Process started", "Joined channel", "Runtime ready", "Reasoning started",
  ]);
  assert.equal(chosen.steps[0].at, "2026-09-22T18:00:00Z");
  assert.equal(summonView(base).steps[0].label, "Environment selected");
  const queued = { ...base, state: "queued", connectedAt: undefined, commandDurableAt: at };
  assert.equal(summonView(queued).label, "Starting");
  assert.equal(step(summonView(queued), "Machine accepted").state, "current");
  assert.match(summonView(queued).detail, /accept the command/);
  const admitted = { ...queued, admittedAt: at };
  assert.equal(step(summonView(admitted), "Process started").state, "current");
  assert.equal(summonView({ ...queued, daemonOffline: true }).animate, false, "a queued command waits without spinning");
});
test("a server connection claim is not a joined channel", () => {
  const view = summonView(base);
  assert.equal(view.label, "Starting");
  assert.equal(view.tone, "active");
  assert.equal(step(view, "Joined channel").state, "current");
  assert.match(view.detail, /client to confirm/);
  assert.equal(invocationPollInterval([base], 0, Date.now(), false), 2000);
});
test("a later checkpoint proves every earlier sub-step", () => {
  const view = summonView({ ...base, connectedAt: undefined, activity: { runStatus: "running", phase: "runtime_ready",
    updatedAt: at, startupSteps: [{ phase: "runtime_ready", at }] } });
  for (const label of ["Machine accepted", "Process started", "Joined channel", "Runtime ready"]) assert.equal(step(view, label).state, "done", label);
  assert.equal(step(view, "Machine accepted").at, undefined, "an inferred step does not borrow a time");
  assert.equal(step(view, "Reasoning started").state, "unknown");
});
test("reasoning started settles the summon; the Run's later outcome never rewrites it", () => {
  // The reported incident: the turn_running checkpoint was never recorded, a
  // reply was committed, then the Run was stopped. It used to read "Stopped"
  // above four "Unconfirmed" steps.
  const incident = { ...base, firstReplyAt: at, activity: { runStatus: "stopped", updatedAt: at,
    startupSteps: [{ phase: "cwd_ready", at }] } };
  const view = summonView(incident);
  assert.equal(view.label, "Started");
  assert.equal(view.tone, "success");
  assert.equal(view.detail, "");
  assert.equal(view.terminal, true);
  for (const label of ["Machine accepted", "Process started", "Joined channel", "Runtime ready", "Reasoning started"]) {
    assert.equal(step(view, label).state, "done", label);
  }
  for (const activity of [{ runStatus: "running", phase: "turn_running" }, { runStatus: "completed" },
    { runStatus: "exited", phase: "turn_failed" }, { runStatus: "running", phase: "run_delivery_failed" }, { runStatus: "failed", phase: "turn_unknown" }]) {
    assert.equal(summonView({ ...base, activity: { ...activity, updatedAt: at } }).label, "Started", JSON.stringify(activity));
  }
  assert.equal(invocationPollInterval([incident], 0, Date.now(), false), false);
});
test("an execution record for the summoning message is reasoning evidence", () => {
  const execution = { id: "record", executionId: "initial", channelId: base.channelId, sourceMessageId: base.sourceMessageId,
    runId: base.runId, instanceId: base.instanceId, state: "accepted",
    startedAt: at, updatedAt: at, observedAt: at, runStatus: "running" };
  assert.equal(summonView(base, [execution]).label, "Started");
  assert.equal(summonView(base, [execution]).executionId, "initial");
  assert.equal(summonView(base, [{ ...execution, sourceMessageId: "other" }]).label, "Starting");
  assert.equal(summonView(base, [{ ...execution, runId: "other" }]).executionId, undefined);
  assert.equal(invocationPollInterval([base], 0, Date.now(), false, [], [{ ...execution, state: "completed", finishedAt: at }]), 15000,
    "executions still refresh so a saved reply can be recovered");
});
test("startup failure names the stuck sub-step and its typed cause", () => {
  const failure = { code: "agent_run_binding_mismatch", stage: "relay.authenticate", originStage: "authority.request",
    diagnosticId: "diag_11111111-1111-4111-8111-111111111111", retryable: false };
  const view = summonView({ ...base, activity: { runStatus: "exited", phase: "wrapper_startup_failed", operationFailure: failure } });
  assert.equal(view.label, "Failed");
  assert.equal(view.tone, "error");
  assert.match(view.detail, /credentials do not match/);
  assert.equal(step(view, "Joined channel").state, "failed");
  assert.equal(step(view, "Process started").state, "done");
  assert.equal(invocationPollInterval([{ ...base, activity: { runStatus: "exited", phase: "wrapper_startup_failed" } }], 0, Date.now(), false), false);
  assert.match(summonView({ ...base, activity: { runStatus: "exited" } }).detail, /Joined channel/);
  assert.equal(summonView({ ...base, state: "cancelled" }).label, "Stopped");
  assert.equal(require("./mention-invocation-state.ts").operationFailureStageLabel("constructor"), "Runtime session");
  assert.equal(require("./mention-invocation-state.ts").operationFailureDescription({ ...failure, token: "PRIVATE" }).includes("PRIVATE"), false);
});
test("stale or unrefreshed evidence keeps its answer but stops spinning", () => {
  const activity = { runStatus: "running", phase: "relay_register_retrying", observedAt: at, updatedAt: at, evidenceStale: true,
    connectionRetry: { kind: "relay_register", attempt: 7 } };
  const stale = summonView({ ...base, activity });
  assert.equal(stale.label, "Starting");
  assert.equal(stale.animate, false);
  assert.match(stale.detail, /attempt 7\. The machine has not reported fresh progress\./);
  const cached = summonView({ ...base, firstReplyAt: at }, [], true);
  assert.equal(cached.label, "Started");
  assert.match(cached.detail, /could not be refreshed/);
  assert.equal(invocationPollInterval([base], 0, Date.now(), true), 10000);
});
test("reborn and handoff read as the same startup", () => {
  const record = { schemaVersion: 1, kind: "handoff", sourceMessageId: "message", sourceMessageVersion: 1,
    sourceMention: "@Alpha:1:handoff:@Beta", sourceName: "Alpha",
    sourceOrdinal: 1, sourceInstanceId: "source-instance", sourceRunId: "source-run",
    targetInstanceId: "target-instance", targetName: "Beta",
    channelId: "channel", runId: "successor", createdAt: "2026-09-13T00:00:00Z",
    activity: { runStatus: "running", phase: "relay_register_retrying", updatedAt: "2026-09-13T00:00:00Z" } };
  const text = `${record.sourceMention} continue; @Alpha:2:reborn other task`;
  const parts = splitMentionContinuations(text, [record]);
  assert.equal(parts.filter(part => part.kind === "continuation").length, 1);
  assert.equal(parts.map(part => part.text).join(""), text);
  assert.equal(splitMentionContinuations("@Alpha:1:handoff:@Gamma", [record]).some(part => part.kind === "continuation"), false);
  assert.equal(splitMentionContinuations(record.sourceMention, [record, { ...record, runId: "ambiguous" }]).some(part => part.kind === "continuation"), false);
  const view = continuationView(record);
  assert.equal(view.label, "Starting");
  assert.equal(view.steps[0].label, "Handoff requested");
  // A running successor proves the handoff, even before its evidence arrives.
  assert.equal(step(view, "Handoff recorded").state, "done");
  assert.equal(step(view, "Successor Run created").state, "done");
  assert.equal(step(view, "Process started").state, "current");
  assert.equal(invocationPollInterval([], 0, Date.now(), false, [record]), 2000);
  assert.equal(continuationView({ ...record, activity: { ...record.activity, runStatus: "exited", phase: undefined } }).label, "Failed");
  assert.equal(continuationView({ ...record, activity: { ...record.activity, phase: "turn_running" } }).label, "Started");
  assert.equal(continuationView({ ...record, activity: { ...record.activity, runStatus: "stopped", phase: undefined } }).label, "Stopped");
  assert.equal(step(continuationView({ ...record, kind: "reborn", predecessorExitedAt: record.createdAt }), "Previous process stopped").state, "done");
});

test("a reborn reads like a summon from the moment it is accepted", () => {
  const accepted = { schemaVersion: 1, kind: "reborn", sourceMessageId: "message", sourceMessageVersion: 1,
    sourceMention: "@claude:3:reborn", sourceName: "claude", sourceOrdinal: 3,
    sourceInstanceId: "instance", sourceRunId: "run:3#1", targetInstanceId: "instance",
    targetName: "claude", channelId: "channel", runId: "run:3#2", createdAt: at,
    reborn: { state: "waiting", stopRequired: true, updatedAt: at } };
  // No successor Run yet: the chip still exists and waits on the stop.
  const stopping = continuationView(accepted);
  assert.equal(stopping.label, "Starting");
  assert.equal(stopping.animate, true);
  assert.equal(step(stopping, "Reborn requested").state, "done");
  assert.equal(step(stopping, "Previous process stopped").state, "current");
  assert.match(stopping.detail, /Stopping the previous process/);
  assert.equal(invocationPollInterval([], 0, Date.now(), false, [accepted]), 2000);
  assert.match(continuationView({ ...accepted, reborn: { ...accepted.reborn, stopRequired: false } }).detail,
    /Preparing to resume/);

  const prepared = { ...accepted, predecessorExitedAt: at, runCreatedAt: at,
    reborn: { ...accepted.reborn, state: "prepared" }, activity: { runStatus: "starting", updatedAt: at } };
  const resuming = continuationView(prepared);
  assert.equal(step(resuming, "Successor Run created").state, "done");
  assert.equal(step(resuming, "Machine accepted").state, "current");
  const accepted2 = continuationView({ ...prepared, reborn: { ...prepared.reborn, state: "spawned" } });
  assert.equal(step(accepted2, "Machine accepted").state, "done");
  assert.equal(step(accepted2, "Process started").state, "current");
  assert.equal(continuationView({ ...prepared, activity: { ...prepared.activity, phase: "turn_running" } }).label, "Started");

  // A refusal before any successor exists is a visible failure with its reason.
  const failed = continuationView({ ...accepted, reborn: { ...accepted.reborn, state: "failed", errorCode: "reborn_spawn_failed" } });
  assert.equal(failed.label, "Failed");
  assert.equal(failed.terminal, true);
  assert.match(failed.detail, /Resuming the original session failed\. \[reborn_spawn_failed\]/);
  assert.equal(step(failed, "Previous process stopped").state, "failed");
  assert.match(continuationView({ ...accepted, reborn: { ...accepted.reborn, state: "failed", errorCode: "internal_secret" } }).detail,
    /\[reborn_failed\]/);
  assert.equal(invocationPollInterval([], 0, Date.now(), false, [{ ...accepted, reborn: { ...accepted.reborn, state: "failed" } }]), false);
});

test("preparation failures match the exact address and preserve the surrounding message", () => {
  const rejection = { sourceMention: "@reviewer:new", targetRef: "reviewer" };
  const text = "@codex:new:owner/repo review; @reviewer:new check this";
  const parts = splitMentionRejections(text, [rejection]);
  assert.equal(parts.filter(part => part.kind === "rejection").length, 1);
  assert.equal(parts.map(part => part.text).join(""), text);
  assert.equal(splitMentionRejections("@reviewer:new:owner/repo", [rejection]).some(part => part.kind === "rejection"), false);
  assert.equal(splitMentionRejections("email@reviewer:new", [rejection]).some(part => part.kind === "rejection"), false);
});

const VOCABULARY = ["Starting", "Started", "Failed", "Stopped"];
const CHIP_TONE = { Starting: "active", Started: "success", Failed: "error", Stopped: "neutral" };
test("every startup speaks the same four-word vocabulary and only a startup in progress spins", () => {
  const source = fs.readFileSync(path.join(__dirname, "mention-invocation-state.ts"), "utf8");

  const phases = [...new Set([...source.matchAll(/"((?:turn|run|wrapper|relay|runtime|channel)_[a-z_]+)"/g)].map(match => match[1])),
    "channel_joined", "relay_registered", "runtime_ready", undefined];
  assert.ok(phases.length > 8, "the sweep must read the real phase list");
  const seen = new Set();
  const check = (view, where) => {
    assert.ok(VOCABULARY.includes(view.label), `${where} produced the label "${view.label}"`);
    assert.equal(view.tone, CHIP_TONE[view.label], `${where} gave "${view.label}" a hand-picked tone`);
    if (view.animate) assert.equal(view.label, "Starting", `${where} spins on "${view.label}"`);
    assert.equal(view.terminal, view.label !== "Starting", where);
    seen.add(view.label);
  };
  for (const phase of phases) for (const runStatus of ["running", "completed", "exited", "failed", "stopped"]) {
    for (const firstReplyAt of [undefined, at]) for (const evidenceStale of [false, true]) for (const unavailable of [false, true]) {
      const activity = { runStatus, phase, evidenceStale, updatedAt: at, observedAt: at };
      check(summonView({ ...base, firstReplyAt, activity }, [], unavailable), `summonView ${runStatus}/${phase}`);
      check(continuationView({ kind: "reborn", runId: "s", sourceRunId: "p", createdAt: at, activity }, unavailable),
        `continuationView ${runStatus}/${phase}`);
    }
  }
  for (const state of ["queued", "admitted", "spawned", "connected", "failed", "cancelled"]) check(summonView({ ...base, state }), `summonView ${state}`);
  assert.deepEqual([...seen].sort(), [...VOCABULARY].sort(), "no word in the vocabulary is dead");
});

test("a written handoff splits out as a card with both Agents, @auto included", () => {
  assert.deepEqual(splitHandoffMentions("@claude:1:handoff:@auto"), [{ kind: "handoff", text: "@claude:1:handoff:@auto",
    sourceName: "claude", sourceOrdinal: 1, successorName: "auto" }]);
  assert.deepEqual(splitHandoffMentions("please @codex:12:handoff:@claude finish it").map(segment => segment.kind === "handoff"
    ? [segment.text, segment.sourceName, segment.sourceOrdinal, segment.successorName] : segment.text),
  ["please ", ["@codex:12:handoff:@claude", "codex", 12, "claude"], " finish it"]);
  // Destination ordinals are not handoffs, and a disallowed position stays text.
  assert.deepEqual(splitHandoffMentions("@codex:1:handoff:@claude:2"), [{ kind: "text", text: "@codex:1:handoff:@claude:2" }]);
  assert.deepEqual(splitHandoffMentions("x @codex:1:handoff:@claude", () => false),
    [{ kind: "text", text: "x @codex:1:handoff:@claude" }]);
});

test("each Agent of a handoff carries its own state in the invocation tones", () => {
  assert.deepEqual(handoffView(undefined, { auto: true, fresh: true }), { source: { label: "Handing off", tone: "active" },
    successor: { label: "Picking", tone: "active" }, flowing: true });
  assert.deepEqual(handoffView(undefined, { auto: false, fresh: false }), { source: { label: "", tone: "neutral" },
    successor: { label: "", tone: "neutral" }, flowing: false }, "an old unrecorded handoff never animates forever");
  const record = { schemaVersion: 1, kind: "handoff", sourceMessageId: "m", sourceMessageVersion: 1,
    sourceMention: "@codex:2:handoff:@claude", sourceInstanceId: "i-2", sourceRunId: "r-2", sourceName: "codex",
    sourceOrdinal: 2, targetInstanceId: "i-3", runId: "r-3", channelId: "c", targetName: "claude", createdAt: at };
  const starting = handoffView(record, { auto: false, fresh: false });
  assert.deepEqual(starting.source, { label: "Handing off", tone: "active" });
  assert.equal(starting.successor.tone, continuationView(record).tone);
  assert.equal(starting.flowing, continuationView(record).tone === "active");
  const moved = handoffView({ ...record, handoffFencedAt: at }, { auto: false, fresh: false });
  assert.deepEqual(moved.source, { label: "Handed off", tone: "neutral" });
});

test("a handoff launch stays on the handoff card, and the newest match wins", () => {
  const mention = "@claude:1:handoff:@auto";
  const older = { ...base, launchId: "old", sourceMention: mention, createdAt: "2026-09-12T15:00:00.000Z" };
  const newer = { ...base, launchId: "new", sourceMention: mention, createdAt: at };
  const segments = segmentMessageInteraction(mention, { launches: [older, newer] });
  assert.deepEqual(segments.map(segment => segment.presentationRef), ["handoff.v1"]);
  assert.equal(segments[0].written.successorName, "auto");
  assert.equal(segments.some(segment => segment.presentationRef === "launch.v1"), false);
  assert.equal(handoffSuccessorLaunch([older, newer], mention), newer);
  assert.equal(handoffSuccessorLaunch([older, newer], "@claude:1:handoff:@grok"), undefined);
});

test("one segmenter tags every interaction span with its presentation contract", () => {
  const continuation = { schemaVersion: 1, kind: "reborn", sourceMention: "@Alpha:2:reborn", sourceName: "Alpha",
    sourceOrdinal: 2, channelId: "channel", runId: "successor", targetName: "Alpha", createdAt: at };
  const rejection = { sourceMention: "@reviewer:new", targetRef: "reviewer", code: "agent_not_found" };
  const launch = { ...base, sourceMention: "@codex", createdAt: at };
  const mentions = run => {
    const at = run.indexOf("@Dana");
    return at < 0 ? [{ kind: "text", text: run }] : [
      ...(at ? [{ kind: "text", text: run.slice(0, at) }] : []),
      { kind: "mention", text: "@Dana", target: { subjectId: "dana" }, token: "Dana" },
      ...(at + 5 < run.length ? [{ kind: "text", text: run.slice(at + 5) }] : []),
    ];
  };
  const text = "@Alpha:2:reborn then @claude:1:handoff:@auto now, @reviewer:new and @codex review; cc @Dana thanks";
  const segments = segmentMessageInteraction(text, { continuations: [continuation], rejections: [rejection],
    launches: [launch], mentions });
  assert.equal(segments.map(segment => segment.text).join(""), text);
  assert.deepEqual(segments.map(segment => [segment.presentationRef, segment.text]), [
    ["reborn.v1", "@Alpha:2:reborn"], [null, " then "],
    ["handoff.v1", "@claude:1:handoff:@auto"], [null, " now, "],
    ["launch.v1", "@reviewer:new"], [null, " and "],
    ["launch.v1", "@codex"], [null, " review; cc "],
    ["mention.v1", "@Dana"], [null, " thanks"],
  ]);
  assert.equal(segments[2].written.successorName, "auto");
  assert.equal(segments[4].rejection, rejection);
  assert.equal(segments[6].launch, launch);
  assert.equal(segments[8].target.subjectId, "dana");
});

test("the segmenter keeps non-operational addresses and unreadable handoffs as prose", () => {
  const { segmentMessageInteraction } = require("./mention-invocation-state.ts");
  const text = "quote `@codex` then @claude:1:handoff:@auto";
  const codeStart = text.indexOf("@codex");
  const segments = segmentMessageInteraction(text, { launchStatusUnavailable: true }, start => start !== codeStart);
  assert.deepEqual(segments.map(segment => segment.presentationRef), [null]);
  assert.equal(segments[0].text, text);
  const offsets = segmentMessageInteraction("x @codex", {}, start => start !== 2);
  assert.deepEqual(offsets.map(segment => segment.presentationRef), [null]);
  const pending = segmentMessageInteraction("x @codex", {});
  assert.deepEqual(pending.map(segment => [segment.presentationRef, segment.launch, segment.rejection]),
    [[null, undefined, undefined], ["launch.v1", undefined, undefined]]);
  assert.deepEqual(segmentMessageInteraction("", {}), []);
});
