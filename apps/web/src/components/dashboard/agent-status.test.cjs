"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readDashboardSource } = require("./source-scan-fixture.cjs");
const { evaluateExtractedSource, extractFunctionSource } = require("./workspace-shell-source-fixture.cjs");

/* docs/design/agent-status.md: yellow is work in hand (solid while the Agent
   works, a still ring while it waits), green is free, and online and idle
   look the same because a reader cannot tell them apart. */

const pick = (file, names) =>
  names.map((name) => extractFunctionSource(readDashboardSource(file), name, { fileName: file })).join("\n");
const { identityStatusDotClass, identityRestStatus, agentInstanceDisplayStatus, agentWaitingPhrase, agentWaitingSubject, agentRuntimeIssuePhrase, agentRuntimeNoticePhrase } = evaluateExtractedSource([
  pick("identity-avatar.tsx", ["identityStatusDotClass", "identityRestStatus"]),
  pick("workspace-shell-presence.ts", ["isMachineOfflineInstance", "agentInstanceDisplayStatus"]),
  pick("agent-work-intent.tsx", ["agentWaitingPhrase", "agentWaitingSubject", "elapsedLabel"]),
  pick("agent-runtime-notice.tsx", ["agentRuntimeIssuePhrase", "agentRuntimeNoticePhrase"]),
].join("\n"), {
  MACHINE_OFFLINE_DISPLAY_STATUS: "machine offline",
  isLiveAgentStatus: (status) => ["online", "busy", "idle"].includes(status),
  agentTraceInstanceIds: (instance) => [instance.id],
  presenceStatusLabel: (presence) => presence.status,
  Layers: "Layers",
  SquareTerminal: "SquareTerminal",
  latestAgentWorkEvent: () => undefined,
  agentTraceEventPhase: () => "",
  isTraceDeltaPhase: () => false,
});

test("runtime symptoms use the same status and safe wording for every harness", () => {
  for (const name of ["codex", "claude", "gemini", "copilot", "opencode"]) {
    assert.equal(agentInstanceDisplayStatus({agentId:"a1",events:[],name,instance:{id:"i1",status:"busy",runtimeState:{status:"running",issue:{kind:"retrying",sinceMillis:1}}}}), "waiting");
  }
  assert.equal(agentRuntimeIssuePhrase({kind:"retrying",sinceMillis:1_000},121_000),"Connection retrying · 2m");
  assert.equal(agentRuntimeIssuePhrase({kind:"stalled",sinceMillis:1_000},301_000),"No runtime progress · 5m");
  assert.equal(agentRuntimeIssuePhrase({kind:"failed",sinceMillis:1_000},0),"Turn failed · <1m");
  assert.equal(agentRuntimeNoticePhrase({severity:"error",sinceMillis:1}),"Agent error notice");
  assert.equal(agentRuntimeNoticePhrase({severity:"unknown",sinceMillis:1}),"Agent notice");
});

test("work in hand is yellow: working breathes, waiting is a still ring", () => {
  const working = identityStatusDotClass("busy");
  const waiting = identityStatusDotClass("waiting");
  assert.match(working, /\bbg-amber-500\b/);
  assert.match(working, /motion-safe:animate-pulse/);
  assert.doesNotMatch(working, /app-status-dot-ring/);
  assert.match(waiting, /\bbg-amber-500\b/);
  assert.match(waiting, /\bapp-status-dot-ring\b/);
  assert.doesNotMatch(waiting, /animate-pulse/);
});

test("online and idle are one free green, and no dot is blue any more", () => {
  assert.equal(identityStatusDotClass("online"), identityStatusDotClass("idle"));
  assert.match(identityStatusDotClass("idle"), /\bbg-emerald-500\b/);
  for (const status of ["busy", "waiting", "online", "idle", "waking", "machine offline", "offline"]) {
    assert.doesNotMatch(identityStatusDotClass(status), /sky-/, status);
  }
  assert.match(identityStatusDotClass("waking"), /\bapp-status-dot-ring\b/);
  assert.match(identityStatusDotClass("machine offline"), /\bbg-red-500\b/);
});

test("a live Instance whose runtime reports a wait displays as waiting", () => {
  const waiting = { kind: "tool", label: "CI", sinceMillis: 1 };
  const base = { id: "i1", connectedAt: "2026-10-04T00:00:00Z" };
  const display = (instance) => agentInstanceDisplayStatus({ agentId: "a1", events: [], instance, name: "claude" });
  assert.equal(display({ ...base, status: "busy", runtimeState: { status: "running", waiting } }), "waiting");
  // Between turns with background tasks still running: idle, but work in hand.
  assert.equal(display({ ...base, status: "idle", runtimeState: { status: "idle", waiting: { kind: "background", sinceMillis: 1 } } }), "waiting");
  assert.equal(display({ ...base, status: "busy", runtimeState: { status: "running" } }), "busy");
  // Resting and unreachable Instances keep their own status whatever was last reported.
  assert.equal(display({ ...base, status: "offline", rest: "sleeping", runtimeState: { status: "idle", waiting } }), "sleeping");
  assert.equal(display({ ...base, status: "offline", rest: "wake_failed", restReason: "reborn_spawn_failed" }), "wake_failed");
  assert.equal(display({ ...base, status: "offline", offlineReason: "machine_offline", runtimeState: { status: "running", waiting } }), "machine offline");
});

test("a waiting ring in the work dock is the status colour, not the white cutout", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "../../app/globals.css"), "utf8");
  const rule = css.match(/\.app-agent-work-avatar \.identity-avatar-status\.app-status-dot-ring\[class\*="bg-amber-"\]\s*\{[^}]+\}/);
  assert.ok(rule, "work dock waiting ring rule");
  assert.match(rule[0], /border-color:\s*oklch\(0\.769 0\.188 70\.08\)/);
  assert.doesNotMatch(rule[0], /oklch\(1 0 0\)/);
});

test("the waiting phrase says what and how long, never a guess", () => {
  const since = Date.UTC(2026, 9, 4, 10, 0, 0);
  assert.equal(agentWaitingPhrase({ kind: "tool", label: "gh pr checks 1 --watch", sinceMillis: since }, since + 4 * 60_000 + 30_000), "waiting: gh pr checks 1 --watch · 4m");
  assert.equal(agentWaitingPhrase({ kind: "tool", sinceMillis: since }, since + 20_000), "waiting: a tool call · <1m");
  assert.equal(agentWaitingPhrase({ kind: "background", sinceMillis: since }, since + 95 * 60_000), "waiting: tasks · 1h 35m");
  // A client clock behind the runtime's never shows a negative wait.
  assert.equal(agentWaitingPhrase({ kind: "tool", label: "curl x", sinceMillis: since }, since - 5_000), "waiting: curl x · <1m");
});

test("the island names what is waited on as the runtime says it, with its kind's icon", () => {
  const subject = (waiting) => agentWaitingSubject({ sinceMillis: 1, ...waiting });
  assert.deepEqual(subject({ kind: "tool", label: "Wait for CI on PR #3781" }), { word: "Wait for CI on PR #3781", icon: "SquareTerminal" });
  assert.deepEqual(subject({ kind: "tool" }), { word: "a tool call", icon: "SquareTerminal" });
  assert.deepEqual(subject({ kind: "background", label: "2 tasks" }), { word: "2 tasks", icon: "Layers" });
});

test("a failed wake rests visibly and says what resumes it", () => {
  assert.equal(identityRestStatus("wake_failed"), "wake_failed");
  assert.match(readDashboardSource("identity-avatar.tsx"),
    /if \(status === "wake_failed"\) return "wake failed, Reborn resumes it";/u);
  assert.equal(identityRestStatus("offline"), undefined);
});
