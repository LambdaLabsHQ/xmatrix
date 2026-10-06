const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  buildAgentConversationTraceStream,
  buildAgentConversationTraceTimeline,
  buildAgentTraceHeaderStatus,
} = require("./agent-trace-stream.ts");

function llmTrace(id, timestamp, phase, payload, source = "codex_app_server") {
  return {
    id,
    type: "observable_event",
    timestamp,
    metadata: {
      eventType: "llm_trace",
      payload: {
        schemaVersion: 1,
        source,
        phase,
        payload,
      },
    },
  };
}

/** The busy Codex Agent whose trace most tests replay. */
const busyCodex = Object.freeze({
  id: "agent:codex",
  name: "codex",
  status: "busy",
  connectedAt: "2026-05-21T00:00:00.000Z",
});

const busyClaude = Object.freeze({ id: "agent:claude", name: "claude", status: "busy", connectedAt: "2026-05-21T00:00:00.000Z" });

/** The busy Grok Agent, reporting over ACP. */
const busyGrok = Object.freeze({
  id: "agent:grok",
  name: "grok-daniel-windows",
  status: "busy",
  connectedAt: "2026-07-13T00:00:00.000Z",
});

/** The body of the timeline's one Output item. */
function onlyOutputBody(timeline) {
  const outputs = timeline.filter((item) => item.kind === "output");
  assert.equal(outputs.length, 1);
  return outputs[0].body;
}

/** A trace event inside the one turn (`thread-1` / `turn-1`) these tests drive. */
function turnTrace(id, timestamp, phase, payload) {
 return llmTrace(id, timestamp, phase, { threadId: "thread-1", turnId: "turn-1", ...payload });
}

function startedTurnTrace(id, timestamp, input) {
  return turnTrace(id, timestamp, "turn_started", { input });
}

function functionCallTrace(id, timestamp, payload) {
  return turnTrace(id, timestamp, "runtime_event", { category: "tool", itemType: "function_call", ...payload });
}

function commandOutputDeltaTrace(id, timestamp, delta) {
  return turnTrace(id, timestamp, "runtime_event", {
    runtimeMethod: "item/commandExecution/outputDelta", category: "tool", status: "delta",
    itemId: "tool-1", itemType: "commandExecution", toolName: "shell_command", details: { delta },
  });
}

test("buildAgentConversationTraceStream preserves streamed deltas by turn without rendering completed text", () => {
  const target = busyCodex;
  const history = [
    {
      messageId: "m1",
      channelId: "c1",
      body: "do work",
      sentAt: "2026-05-21T00:00:01.000Z",
      from: { kind: "user", label: "Yiming Hu", identityId: "user:1" },
    },
  ];
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.100Z", "do work"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "assistant_delta", {
      delta: "thinking step\n",
      sourceMethod: "rawResponseItem/delta",
    }),
    turnTrace("e3", "2026-05-21T00:00:03.000Z", "assistant_delta", {
      delta: "tool observation\n",
      sourceMethod: "rawResponseItem/delta",
    }),
    turnTrace("e4", "2026-05-21T00:00:04.000Z", "turn_completed", {
      text: "completed text",
    }),
    llmTrace("e5", "2026-05-21T00:00:05.000Z", "turn_started", {
      threadId: "thread-1",
      turnId: "turn-2",
      input: "follow up",
    }),
    llmTrace("e6", "2026-05-21T00:00:06.000Z", "assistant_delta", {
      threadId: "thread-1",
      turnId: "turn-2",
      delta: "second turn stream",
    }),
  ];

  const stream = buildAgentConversationTraceStream(history, target, events);

  assert.match(stream, /### Input\s+do work/);
  assert.match(stream, /### Output\s+thinking step\ntool observation/);
  assert.equal(stream.includes("### Completed response"), false);
  assert.equal(stream.includes("completed text"), false);
  assert.match(stream, /### Input\s+follow up/);
  assert.match(stream, /### Output\s+second turn stream/);
  assert.equal(stream.includes("Received from Yiming Hu\n\ndo work"), false);
  assert.ok(stream.indexOf("do work") < stream.indexOf("thinking step"));
  assert.ok(stream.indexOf("tool observation") < stream.indexOf("follow up"));
});

test("buildAgentConversationTraceStream splits Claude message-id delta segments", () => {
  const target = busyClaude;
  const events = [
    llmTrace("e1", "2026-05-21T00:00:01.000Z", "turn_started", {
      input: "continue",
    }),
    llmTrace("e2", "2026-05-21T00:00:02.000Z", "assistant_delta", {
      delta: "First answer.",
      messageId: "msg_1",
    }),
    llmTrace("e3", "2026-05-21T00:00:03.000Z", "assistant_delta", {
      delta: "\n\nSecond answer.",
      messageId: "msg_2",
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Output\s+First answer\./);
  assert.match(stream, /### Output\s+Second answer\./);
  assert.ok(stream.indexOf("First answer.") < stream.indexOf("Second answer."));
});

test("buildAgentConversationTraceStream renders only real trace events and keeps envelopes raw", () => {
  const target = busyCodex;
  const history = [
    {
      messageId: "m1",
      channelId: "c1",
      body: "find the root cause, do not guess",
      sentAt: "2026-05-21T00:00:01.000Z",
      from: { kind: "user", label: "Yiming Hu", identityId: "user:1" },
    },
  ];
  const assignment = [
    "You received a message from xMatrix chat by Yiming Hu (user).",
    "This is an explicit assignment to this agent.",
    "",
    "Recent channel context:",
    "- Yiming Hu: find the root cause, do not guess",
  ].join("\n");
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.100Z", assignment),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "turn_completed", {
      text: "completed text",
    }),
  ];

  const stream = buildAgentConversationTraceStream(history, target, events);

  assert.match(stream, /### Input\s+You received a message from xMatrix chat by Yiming Hu/);
  assert.match(stream, /Recent channel context:\n- Yiming Hu: find the root cause, do not guess/);
  assert.equal(stream.includes("### Received from Yiming Hu"), false);
});

test("buildAgentConversationTraceStream groups turns from newest-first event windows", () => {
  const target = busyCodex;
  const events = [
    turnTrace("e4", "2026-05-21T00:00:04.000Z", "turn_completed", {
      text: "completed text",
    }),
    turnTrace("e3", "2026-05-21T00:00:03.000Z", "assistant_delta", {
      delta: "second",
    }),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "assistant_delta", {
      delta: "first ",
    }),
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "prompt"),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.ok(stream.indexOf("prompt") < stream.indexOf("first second"));
  assert.equal(stream.includes("completed text"), false);
});

test("buildAgentConversationTraceStream keeps streamed chunk boundaries out of output text", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "prompt"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "assistant_delta", {
      delta: "考虑优化，",
    }),
    turnTrace("e3", "2026-05-21T00:00:03.000Z", "assistant_delta", {
      delta: "但不要一刀切。",
    }),
    turnTrace("e4", "2026-05-21T00:00:04.000Z", "assistant_delta", {
      delta: "\n可以安全优先处理。",
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Output\s+考虑优化，但不要一刀切。\n可以安全优先处理。/);
});

test("buildAgentConversationTraceStream coalesces Grok session-only deltas without turn keys", () => {
  const target = busyGrok;
  // Historical grok_acp events only carried sessionId. When turn_started is also
  // outside the visible window, each chunk must still join into one Output body
  // instead of becoming a one-token-per-line vertical list.
  const events = [
    llmTrace("g2", "2026-07-13T00:00:02.000Z", "assistant_delta", {
      sessionId: "sess-1",
      delta: "把",
    }, "grok_acp"),
    llmTrace("g3", "2026-07-13T00:00:03.000Z", "assistant_delta", {
      sessionId: "sess-1",
      delta: "kache",
    }, "grok_acp"),
    llmTrace("g4", "2026-07-13T00:00:04.000Z", "assistant_delta", {
      sessionId: "sess-1",
      delta: "日志挪到真正跑 rust cli 时再输出。",
    }, "grok_acp"),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);
  const timeline = buildAgentConversationTraceTimeline([], target, events);

  assert.equal(onlyOutputBody(timeline), "把kache日志挪到真正跑 rust cli 时再输出。");
  assert.match(stream, /### Output\s+把kache日志挪到真正跑 rust cli 时再输出。/);
});

test("buildAgentConversationTraceTimeline renders Grok ACP tool_call_update events", () => {
  const target = {
    id: "agent:grok",
    name: "grok-daniel-windows",
    status: "busy",
  };
  const events = [
    llmTrace("grok-tool-1", "2026-07-13T00:00:02.000Z", "tool_call_update", {
      sessionId: "session-1",
      threadId: "session-1",
      turnId: "5",
      update: {
        sessionUpdate: "tool_call_update",
        status: "in_progress",
        toolCallId: "call-1",
        content: [{ content: { text: "pnpm test: 249 tests passed" } }],
      },
    }, "grok_acp"),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);

  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, "tool");
  assert.match(timeline[0].body, /pnpm test: 249 tests passed/);
  assert.deepEqual(timeline[0].fields, [
    { label: "Type", value: "tool_call_update" },
    { label: "Status", value: "in_progress" },
    { label: "Call ID", value: "call-1" },
  ]);
});

test("buildAgentConversationTraceStream keeps Grok turnId-scoped deltas together", () => {
  const target = busyGrok;
  const events = [
    llmTrace("g1", "2026-07-13T00:00:01.000Z", "turn_started", {
      sessionId: "sess-1",
      threadId: "sess-1",
      turnId: "7",
      input: "fix vertical tokens",
    }, "grok_acp"),
    llmTrace("g2", "2026-07-13T00:00:02.000Z", "assistant_delta", {
      sessionId: "sess-1",
      threadId: "sess-1",
      turnId: "7",
      delta: "把",
    }, "grok_acp"),
    llmTrace("g3", "2026-07-13T00:00:03.000Z", "assistant_delta", {
      sessionId: "sess-1",
      threadId: "sess-1",
      turnId: "7",
      delta: "kache",
    }, "grok_acp"),
    llmTrace("g4", "2026-07-13T00:00:04.000Z", "assistant_delta", {
      sessionId: "sess-1",
      threadId: "sess-1",
      turnId: "7",
      delta: " 日志",
    }, "grok_acp"),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);
  assert.equal(onlyOutputBody(timeline), "把kache 日志");
});

test("buildAgentConversationTraceTimeline renders opencode ACP tool_call and tool_call_update frames", () => {
  const target = {
    id: "agent:opencode",
    name: "opencode",
    status: "busy",
  };
  // Shapes captured from `opencode acp` 1.18.31: the pending frame is phase
  // "tool_call" (not tool_call_update) and carries its payload under `update`,
  // with tool title/kind and arguments in rawInput / output in rawOutput.
  const events = [
    llmTrace("oc-tool-1", "2026-09-21T00:00:02.000Z", "tool_call", {
      sessionId: "ses-1",
      threadId: "ses-1",
      turnId: "3",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "bash",
        kind: "execute",
        status: "pending",
        locations: [{ path: "/tmp/opencode-test.ts", line: 3 }],
        rawInput: { command: "echo hello-from-tool" },
      },
    }, "opencode_acp"),
    llmTrace("oc-tool-2", "2026-09-21T00:00:03.000Z", "tool_call_update", {
      sessionId: "ses-1",
      threadId: "ses-1",
      turnId: "3",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        title: "echo hello-from-tool",
        kind: "execute",
        status: "completed",
        rawOutput: "hello-from-tool",
      },
    }, "opencode_acp"),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);

  // One invocation: the pending tool_call and its updates fold into one card.
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, "tool");
  assert.equal(timeline[0].title, "Tool call");
  assert.match(timeline[0].body, /Tool: bash/);
  assert.match(timeline[0].body, /Kind: execute/);
  assert.match(timeline[0].body, /Status: completed/);
  assert.match(timeline[0].body, /echo hello-from-tool/);
  assert.match(timeline[0].body, /\/tmp\/opencode-test\.ts:3/);
  assert.match(timeline[0].body, /hello-from-tool/);
});

test("buildAgentConversationTraceTimeline reuses parsed events without leaking merges between builds", () => {
  const target = { id: "agent:opencode", name: "opencode", status: "busy" };
  const pending = llmTrace("cache-tool-1", "2026-09-21T00:00:02.000Z", "tool_call", {
    threadId: "ses-1",
    turnId: "3",
    update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "bash", status: "pending" },
  }, "opencode_acp");
  const completed = llmTrace("cache-tool-2", "2026-09-21T00:00:03.000Z", "tool_call_update", {
    threadId: "ses-1",
    turnId: "3",
    update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: "done" },
  }, "opencode_acp");
  const undated = { ...llmTrace("cache-undated", undefined, "assistant_delta", { delta: "late" }) };

  // A replica that did not change keeps its events array: a lookup, same items.
  const both = [pending, completed];
  const first = buildAgentConversationTraceTimeline([], target, both);
  assert.equal(buildAgentConversationTraceTimeline([], target, both), first);
  assert.match(first[0].body, /Status: completed/);

  // A new page arrives as a new array of the same event objects. The earlier
  // build merged the update into the pending card; that must not have
  // rewritten the cached parse of the pending frame itself.
  const pendingOnly = buildAgentConversationTraceTimeline([], target, [pending]);
  assert.equal(pendingOnly.length, 1);
  assert.match(pendingOnly[0].body, /Status: pending/);
  assert.doesNotMatch(pendingOnly[0].body, /done/);
  assert.deepEqual(buildAgentConversationTraceTimeline([], target, [pending, completed]), first);

  // An undated event keeps one position across rebuilds (a stable card key).
  const undatedFirst = buildAgentConversationTraceTimeline([], target, [undated]);
  const undatedLater = buildAgentConversationTraceTimeline([], target, [undated, pending]);
  assert.equal(undatedLater.find((item) => item.kind === "output").timestamp, undatedFirst[0].timestamp);
});

test("buildAgentConversationTraceTimeline renders opencode ACP reasoning and plan updates", () => {
  const target = {
    id: "agent:opencode",
    name: "opencode",
    status: "busy",
  };
  const events = [
    llmTrace("oc-r1", "2026-09-21T00:00:02.000Z", "runtime_event", {
      sessionId: "ses-1",
      threadId: "ses-1",
      turnId: "3",
      category: "reasoning",
      status: "delta",
      delta: "Let me inspect the file first.",
    }, "opencode_acp"),
    llmTrace("oc-p1", "2026-09-21T00:00:03.000Z", "runtime_event", {
      sessionId: "ses-1",
      threadId: "ses-1",
      turnId: "3",
      category: "plan",
      status: "info",
      summary: "Plan updated",
      details: { entries: [{ content: "Inspect file", status: "in_progress" }] },
    }, "opencode_acp"),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);

  const reasoning = timeline.find((item) => item.title === "Reasoning");
  assert.ok(reasoning);
  assert.match(reasoning.body, /Let me inspect the file first\./);
  const plan = timeline.find((item) => item.title === "Plan");
  assert.ok(plan);
  assert.match(plan.body, /Inspect file/);
});

test("buildAgentConversationTraceStream renders tool call trace events", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "inspect files"),
    functionCallTrace("e2", "2026-05-21T00:00:02.000Z", {
      runtimeMethod: "rawResponseItem/started",
      status: "started",
      summary: "tool started: exec_command",
      itemId: "tool-1",
      toolName: "exec_command",
      details: {
        arguments: { cmd: "rg trace apps/web" },
      },
      rawPreview: '{"item":{"type":"function_call"}}',
    }),
    functionCallTrace("e3", "2026-05-21T00:00:03.000Z", {
      runtimeMethod: "rawResponseItem/completed",
      status: "completed",
      summary: "tool completed: exec_command",
      itemId: "tool-1",
      toolName: "exec_command",
      details: {
        output: "apps/web/src/components/dashboard/agent-trace-stream.ts",
      },
      rawPreview: '{"item":{"status":"completed"}}',
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Tool call started[\s\S]*Tool: exec_command/);
  assert.match(stream, /Type: function_call/);
  assert.match(stream, /Arguments:\s+\{\n  "cmd": "rg trace apps\/web"\n\}/);
  assert.match(stream, /### Tool call completed[\s\S]*Tool: exec_command/);
  assert.match(stream, /Output:\s+apps\/web\/src\/components\/dashboard\/agent-trace-stream.ts/);
});

test("buildAgentConversationTraceStream interleaves output segments with runtime tool events", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "inspect files"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "assistant_delta", {
      delta: "我会先定位路径。",
    }),
    functionCallTrace("e3", "2026-05-21T00:00:03.000Z", {
      runtimeMethod: "rawResponseItem/completed",
      status: "completed",
      summary: "tool completed: shell_command",
      itemId: "tool-1",
      toolName: "shell_command",
      details: {
        output: "apps/web/src/components/dashboard/agent-trace-stream.ts",
      },
    }),
    turnTrace("e4", "2026-05-21T00:00:04.000Z", "assistant_delta", {
      delta: "现在继续分析渲染。",
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(
    stream,
    /### Output\s+我会先定位路径。\s+### Tool call completed[\s\S]*Tool: shell_command[\s\S]*### Output\s+现在继续分析渲染。/
  );
  assert.equal(stream.includes("我会先定位路径。现在继续分析渲染。"), false);
});

test("buildAgentConversationTraceStream separates Claude assistant messages without explicit newlines", () => {
  const target = busyClaude;
  const events = [
    llmTrace("e1", "2026-05-21T00:00:01.000Z", "assistant_delta", {
      delta: "收到，我先看现象。",
      messageId: "msg-1",
      rawType: "assistant",
    }),
    llmTrace("e2", "2026-05-21T00:00:02.000Z", "assistant_delta", {
      delta: "现在补工具调用展示。",
      messageId: "msg-2",
      rawType: "assistant",
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Output\s+收到，我先看现象。\s+### Output\s+现在补工具调用展示。/);
  assert.equal(stream.includes("收到，我先看现象。现在补工具调用展示。"), false);
});

test("buildAgentConversationTraceStream renders Codex local shell call runtime events", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "check status"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "runtime_event", {
      runtimeMethod: "responseItem/completed",
      category: "tool",
      status: "completed",
      summary: "tool completed: shell_command",
      itemId: "call-2",
      itemType: "local_shell_call",
      toolName: "shell_command",
      details: {
        call_id: "call_abc",
        action: { type: "shell_command", command: "git status --short" },
        output: " M packages/cli-rs/src/main.rs",
      },
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Tool call completed\s+Summary: tool completed: shell_command/);
  assert.match(stream, /Method: responseItem\/completed/);
  assert.match(stream, /Tool: shell_command/);
  assert.match(stream, /Type: local_shell_call/);
  assert.match(stream, /Command: git status --short/);
  assert.match(stream, /Output:\s+M packages\/cli-rs\/src\/main.rs/);
});

test("buildAgentConversationTraceStream renders Codex function call output runtime events", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "check status"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "runtime_event", {
      runtimeMethod: "rawResponseItem/completed",
      category: "tool",
      status: "completed",
      summary: "tool completed: function_call_output",
      itemType: "function_call_output",
      details: {
        call_id: "call_abc",
        output: "Exit code: 0\nWall time: 0.3 seconds\nOutput:\n M packages/cli-rs/src/main.rs",
      },
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Tool call completed\s+Summary: tool completed: function_call_output/);
  assert.match(stream, /Type: function_call_output/);
  assert.match(stream, /Call ID: call_abc/);
  assert.match(stream, /Exit code: 0/);
  assert.match(stream, /M packages\/cli-rs\/src\/main.rs/);
});

test("buildAgentConversationTraceStream renders historical Codex custom tool and patch events", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "apply patch"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "runtime_event", {
      runtimeMethod: "responseItem/completed",
      category: "tool",
      status: "completed",
      summary: "tool completed: apply_patch",
      itemType: "custom_tool_call",
      toolName: "apply_patch",
      details: {
        call_id: "call_patch",
        input: "*** Begin Patch\n*** End Patch",
      },
    }),
    turnTrace("e3", "2026-05-21T00:00:03.000Z", "runtime_event", {
      runtimeMethod: "responseItem/completed",
      category: "tool",
      status: "completed",
      summary: "tool completed: patch_apply_end",
      itemType: "patch_apply_end",
      details: {
        call_id: "call_patch",
        success: true,
        stdout: "Success. Updated files",
        changes: ["packages/cli-rs/src/main.rs"],
      },
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Tool call completed\s+Summary: tool completed: apply_patch/);
  assert.match(stream, /Tool: apply_patch/);
  assert.match(stream, /Type: custom_tool_call/);
  assert.match(stream, /### Tool call completed[\s\S]*Summary: tool completed: patch_apply_end/);
  assert.match(stream, /Type: patch_apply_end/);
  assert.match(stream, /Success: true/);
  assert.match(stream, /packages\/cli-rs\/src\/main.rs/);
});

test("buildAgentConversationTraceStream renders current Codex app-server tool items", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "inspect current protocol"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "runtime_event", {
      runtimeMethod: "item/completed",
      category: "tool",
      status: "completed",
      summary: "tool completed: commandExecution",
      itemId: "cmd-1",
      itemType: "commandExecution",
      details: {
        command: "codex app-server generate-json-schema --out tmp/codex-app-schema",
        cwd: "C:/Users/Daniel/Projects/xmatrix",
        aggregatedOutput: "generated schema",
        exitCode: 0,
      },
    }),
    turnTrace("e3", "2026-05-21T00:00:03.000Z", "runtime_event", {
      runtimeMethod: "item/mcpToolCall/progress",
      category: "tool",
      status: "delta",
      summary: "tool delta: item/mcpToolCall/progress",
      itemId: "mcp-1",
      details: {
        itemId: "mcp-1",
        message: "calling take_snapshot",
      },
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Tool call completed\s+Summary: tool completed: commandExecution/);
  assert.match(stream, /Method: item\/completed/);
  assert.match(stream, /Type: commandExecution/);
  assert.match(stream, /generate-json-schema --out tmp\/codex-app-schema/);
  assert.match(stream, /### Tool call update\s+calling take_snapshot/);
  assert.match(stream, /calling take_snapshot/);
});

test("buildAgentConversationTraceStream merges runtime tool delta chunks", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "run tool"),
    commandOutputDeltaTrace("e2", "2026-05-21T00:00:02.000Z", "const fs = require(\"node:fs\");\n"),
    commandOutputDeltaTrace("e3", "2026-05-21T00:00:03.000Z", "const source = fs.readFileSync(sourcePath, \"utf8\");\n"),
    commandOutputDeltaTrace("e4", "2026-05-21T00:00:04.000Z", "target: ts.ScriptTarget.ES2022,\n"),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);
  const timeline = buildAgentConversationTraceTimeline([], target, events);
  const updates = timeline.filter((item) => item.title === "Tool call update");

  assert.equal(updates.length, 1);
  assert.match(stream, /### Tool call update\s+const fs = require\("node:fs"\);\nconst source = fs\.readFileSync\(sourcePath, "utf8"\);\ntarget: ts\.ScriptTarget\.ES2022,/);
  assert.equal(stream.match(/### Tool call update/g).length, 1);
});

test("buildAgentConversationTraceStream renders Claude stream-json tool use and result events", () => {
  const target = busyClaude;
  const events = [
    llmTrace("e1", "2026-05-21T00:00:01.000Z", "turn_started", {
      input: "inspect current files",
    }),
    llmTrace("e2", "2026-05-21T00:00:02.000Z", "assistant_delta", {
      delta: "我先看相关文件。",
      rawType: "assistant",
    }),
    llmTrace("e3", "2026-05-21T00:00:03.000Z", "tool_call_started", {
      sourceMethod: "stream-json/assistant",
      item: {
        type: "tool_use",
        id: "toolu_1",
        name: "Read",
        input: { file_path: "apps/web/src/components/dashboard/agent-trace-stream.ts" },
      },
    }),
    llmTrace("e4", "2026-05-21T00:00:04.000Z", "tool_result", {
      sourceMethod: "stream-json/user",
      item: {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "loaded file",
      },
    }),
    llmTrace("e5", "2026-05-21T00:00:05.000Z", "assistant_delta", {
      delta: "\n\n继续修复。",
      rawType: "assistant",
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Output\s+我先看相关文件。/);
  assert.match(stream, /### Tool call started[\s\S]*Tool: Read/);
  assert.match(stream, /Type: tool_use/);
  assert.match(stream, /"file_path": "apps\/web\/src\/components\/dashboard\/agent-trace-stream.ts"/);
  assert.match(stream, /### Tool result[\s\S]*Type: tool_result/);
  assert.match(stream, /Output:\s+loaded file/);
  assert.match(stream, /### Output\s+继续修复。/);
});

test("buildAgentConversationTraceStream renders Claude AskUserQuestion tool calls", () => {
  const target = busyClaude;
  const events = [
    llmTrace("e1", "2026-05-21T00:00:01.000Z", "tool_call_started", {
      sourceMethod: "stream-json/assistant",
      item: {
        type: "tool_call",
        id: "toolu_ask",
        name: "AskUserQuestion",
        input: {
          questions: [{ question: "Choose A or B" }],
        },
      },
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Tool call started[\s\S]*Tool: AskUserQuestion/);
  assert.match(stream, /Type: tool_call/);
  assert.match(stream, /Call ID: toolu_ask|Item ID: toolu_ask/);
  assert.match(stream, /"question": "Choose A or B"/);
});

test("buildAgentConversationTraceStream renders unknown trace phases with payload text", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "prompt"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "model_notice", {
      message: "context compacted",
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Model Notice\s+context compacted/);
});

test("buildAgentConversationTraceStream renders generic runtime events without dropping future trace shapes", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "prompt"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "runtime_event", {
      runtimeMethod: "rawResponseItem/futureThing",
      category: "item",
      status: "info",
      summary: "item info: future_widget",
      itemId: "future-1",
      itemType: "future_widget",
      rawPreview: '{"authorization":"[redacted]","text":"hello"}',
    }),
    turnTrace("e3", "2026-05-21T00:00:03.000Z", "runtime_event", {
      runtimeMethod: "turn/diff/updated",
      category: "turn",
      status: "info",
      summary: "turn info: turn/diff/updated",
      rawPreview: '{"diff":"diff --git a/file b/file"}',
    }),
    turnTrace("e4", "2026-05-21T00:00:04.000Z", "runtime_event", {
      runtimeMethod: "item/completed",
      category: "message",
      status: "completed",
      summary: "message completed: agentMessage",
      itemId: "msg-1",
      itemType: "agentMessage",
      details: {
        id: "msg-1",
        type: "agentMessage",
      },
    }),
    turnTrace("e5", "2026-05-21T00:00:05.000Z", "assistant_delta", {
      delta: "readable work update",
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Output\s+readable work update/);
  assert.match(stream, /### Runtime event\s+Summary: item info: future_widget/);
  assert.match(stream, /Method: rawResponseItem\/futureThing/);
  assert.equal(stream.includes("authorization"), false);
  assert.equal(stream.includes("turn/diff/updated"), false);
  assert.equal(stream.includes("message completed: agentMessage"), false);
});

test("buildAgentConversationTraceTimeline exposes typed timeline items for UI rendering", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "inspect files"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "assistant_delta", {
      delta: "我先看文件。",
    }),
    turnTrace("e3", "2026-05-21T00:00:03.000Z", "runtime_event", {
      runtimeMethod: "item/completed",
      category: "tool",
      status: "completed",
      summary: "tool completed: commandExecution",
      itemType: "commandExecution",
      details: { command: "git status --short", exitCode: 0 },
    }),
    turnTrace("e4", "2026-05-21T00:00:04.000Z", "runtime_event", {
      runtimeMethod: "turn/diff/updated",
      category: "turn",
      status: "info",
      summary: "turn info: diff updated",
    }),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);

  assert.deepEqual(
    timeline.map((item) => item.kind),
    ["input", "output", "tool"]
  );
  assert.equal(timeline[2].title, "Tool call completed");
  assert.match(timeline[2].body, /git status --short/);
});

for (const { name, runtime, hidden } of [
  {
    name: "noisy turn diff",
    runtime: {
      runtimeMethod: "turn/diff/updated",
      category: "turn",
      status: "info",
      summary: "turn info: turn/diff/updated",
      rawPreview: '{"runtimeMethod":"turn/diff/updated"}',
    },
    hidden: ["turn/diff/updated"],
  },
  {
    name: "completed user message",
    runtime: {
      runtimeMethod: "item/completed",
      category: "item",
      status: "completed",
      summary: "item completed: userMessage",
      itemId: "msg-1",
      details: {
        id: "msg-1",
        type: "userMessage",
      },
    },
    hidden: ["item completed: userMessage", "userMessage"],
  },
]) {
  test(`buildAgentConversationTraceTimeline hides ${name} runtime events`, () => {
    const target = busyCodex;
    const events = [
      startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "inspect files"),
      turnTrace("e2", "2026-05-21T00:00:02.000Z", "runtime_event", runtime),
      turnTrace("e3", "2026-05-21T00:00:03.000Z", "assistant_delta", {
        delta: "done",
      }),
    ];

    const timeline = buildAgentConversationTraceTimeline([], target, events);
    const stream = buildAgentConversationTraceStream([], target, events);

    assert.deepEqual(
      timeline.map((item) => item.kind),
      ["input", "output"]
    );
    for (const text of hidden) assert.equal(stream.includes(text), false);
  });
}

test("buildAgentConversationTraceTimeline renders reasoning as a compact runtime marker", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "inspect files"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "runtime_event", {
      runtimeMethod: "item/started",
      category: "reasoning",
      status: "started",
      summary: "reasoning started: reasoning",
      itemId: "rs_123",
      itemType: "reasoning",
      rawPreview: '{"id":"rs_123","runtimeMethod":"item/started","type":"reasoning"}',
    }),
    turnTrace("e3", "2026-05-21T00:00:03.000Z", "assistant_delta", {
      delta: "done",
    }),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);
  const stream = buildAgentConversationTraceStream([], target, events);
  const reasoning = timeline.find((item) => item.title === "Reasoning");

  assert.ok(reasoning);
  assert.equal(reasoning.body, "Reasoning started");
  assert.equal(reasoning.blocks.length, 0);
  assert.equal(stream.includes("runtimeMethod"), false);
  assert.equal(stream.includes("rs_123"), false);
  assert.match(stream, /### Reasoning\s+Reasoning started/);
});

test("buildAgentConversationTraceTimeline extracts nested JSON tool payloads into readable fields", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "inspect tool payload"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "runtime_event", {
      runtimeMethod: "item/completed",
      category: "tool",
      status: "completed",
      summary: "tool completed: mcpToolCall",
      itemId: "mcp-1",
      details: {
        item: {
          id: "mcp-1",
          type: "mcpToolCall",
          status: "completed",
          server: "chrome_devtools",
          tool: "take_snapshot",
          arguments: { verbose: false },
          result: { ok: true },
          durationMs: 7,
        },
      },
      rawPreview: '{"item":{"type":"mcpToolCall","result":{"ok":true}}}',
    }),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);
  const tool = timeline.find((item) => item.kind === "tool");

  assert.ok(tool);
  assert.equal(tool.title, "Tool call completed");
  assert.deepEqual(
    tool.fields.map((field) => [field.label, field.value]).filter(([label]) => ["Tool", "Type", "Status", "Item ID"].includes(label)),
    [
      ["Tool", "take_snapshot"],
      ["Type", "mcpToolCall"],
      ["Status", "completed"],
      ["Item ID", "mcp-1"],
    ]
  );
  assert.ok(tool.blocks.some((block) => block.label === "Arguments" && block.collapsed));
  assert.ok(tool.blocks.some((block) => block.label === "Output" && block.collapsed));
  assert.ok(tool.blocks.some((block) => block.label === "Raw preview" && block.collapsed));
  assert.equal(tool.body.includes('Details:\n{\n  "item"'), false);
});

test("buildAgentConversationTraceTimeline renders file changes as a patch instead of delta fragments", () => {
  const target = busyCodex;
  const diff = '@@ -1,2 +1,2 @@\n-const oldValue = 1;\n+const newValue = 1;';
  const events = [
    startedTurnTrace("e1", "2026-05-21T00:00:01.000Z", "edit file"),
    turnTrace("e2", "2026-05-21T00:00:02.000Z", "runtime_event", {
      runtimeMethod: "item/fileChange/patchUpdated",
      category: "tool",
      status: "delta",
      summary: "tool delta: fileChange",
      itemType: "fileChange",
      details: { delta: ".run_id" },
    }),
    turnTrace("e3", "2026-05-21T00:00:03.000Z", "runtime_event", {
      runtimeMethod: "item/completed",
      category: "tool",
      status: "completed",
      summary: "tool completed: fileChange",
      itemType: "fileChange",
      details: {
        type: "fileChange",
        path: "apps/web/src/components/dashboard/workspace-app-shell.tsx",
        changes: [{ diff, kind: { type: "update", move_path: null } }],
      },
    }),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);
  const stream = buildAgentConversationTraceStream([], target, events);
  const tools = timeline.filter((item) => item.kind === "tool");

  assert.equal(tools.length, 1);
  assert.equal(tools[0].fields.find((field) => field.label === "Path").value, "apps/web/src/components/dashboard/workspace-app-shell.tsx");
  assert.ok(tools[0].blocks.some((block) => block.label === "Patch" && block.format === "diff" && block.text.includes("+const newValue")));
  assert.equal(stream.includes(".run_id"), false);
  assert.equal(stream.includes('"diff"'), false);
  assert.match(stream, /\+const newValue = 1;/);
});

test("buildAgentConversationTraceStream renders every trace turn", () => {
  const target = busyCodex;
  const events = [];
  for (let turn = 1; turn <= 9; turn += 1) {
    events.push(
      llmTrace(`s${turn}`, `2026-05-21T00:00:${String(turn).padStart(2, "0")}.000Z`, "turn_started", {
        threadId: "thread-1",
        turnId: `turn-${turn}`,
        input: `prompt ${turn}`,
      }),
      llmTrace(`d${turn}`, `2026-05-21T00:00:${String(turn).padStart(2, "0")}.100Z`, "assistant_delta", {
        threadId: "thread-1",
        turnId: `turn-${turn}`,
        delta: `output ${turn}`,
      })
    );
  }

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.match(stream, /### Input\s+prompt 1/);
  assert.match(stream, /### Output\s+output 1/);
  assert.match(stream, /### Input\s+prompt 2/);
  assert.match(stream, /### Output\s+output 2/);
  assert.match(stream, /### Input\s+prompt 9/);
  assert.match(stream, /### Output\s+output 9/);
});

test("buildAgentConversationTraceStream does not interleave overlapping turns", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("s1", "2026-05-21T00:00:01.000Z", "first prompt"),
    llmTrace("s2", "2026-05-21T00:00:02.000Z", "turn_started", {
      threadId: "thread-1",
      turnId: "turn-2",
      input: "second prompt",
    }),
    llmTrace("d2", "2026-05-21T00:00:03.000Z", "assistant_delta", {
      threadId: "thread-1",
      turnId: "turn-2",
      delta: "second output",
    }),
    turnTrace("d1", "2026-05-21T00:00:04.000Z", "assistant_delta", {
      delta: "first output",
    }),
  ];

  const stream = buildAgentConversationTraceStream([], target, events);

  assert.ok(stream.indexOf("first prompt") < stream.indexOf("first output"));
  assert.ok(stream.indexOf("first output") < stream.indexOf("second prompt"));
  assert.ok(stream.indexOf("second prompt") < stream.indexOf("second output"));
});

function reconnectingTraceEvents(attempts) {
  return [startedTurnTrace("s1", "2026-05-21T00:00:01.000Z", "do work"),
    ...attempts.map(attempt => reconnectTraceEvent(`r${attempt}`, `2026-05-21T00:00:0${attempt}.000Z`, attempt))];
}

test("buildAgentConversationTraceTimeline coalesces reconnect errors into one status item", () => {
  const target = busyCodex;
  const events = [
    ...reconnectingTraceEvents([2, 3, 4, 5]),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);
  const reconnecting = timeline.filter((item) => item.title === "Connection reconnecting");

  assert.equal(reconnecting.length, 1);
  assert.equal(reconnecting[0].kind, "status");
  assert.match(reconnecting[0].body, /Reconnecting\.\.\. 5\/5/);
  assert.match(reconnecting[0].body, /request timed out/);
  assert.ok(reconnecting[0].fields.some((field) => field.label === "Attempts seen" && field.value === "4"));
  assert.equal(timeline.filter((item) => item.kind === "error").length, 0);
});

test("buildAgentConversationTraceTimeline treats legacy reconnect error events as status", () => {
  const target = busyCodex;
  const legacyReconnect = (id, timestamp, attempt) =>
    turnTrace(id, timestamp, "runtime_event", {
      runtimeMethod: "error",
      category: "error",
      status: "failed",
      summary: "error failed: error",
      details: {
        runtimeMethod: "error",
        error: {
          message: `Reconnecting... ${attempt}/5`,
          additionalDetails: "request timed out",
        },
      },
    });
  const events = [
    startedTurnTrace("s1", "2026-05-21T00:00:01.000Z", "do work"),
    legacyReconnect("r2", "2026-05-21T00:00:02.000Z", 2),
    legacyReconnect("r3", "2026-05-21T00:00:03.000Z", 3),
    turnTrace("r6", "2026-05-21T00:00:06.000Z", "runtime_event", {
      runtimeMethod: "error",
      category: "error",
      status: "failed",
      summary: "error failed: error",
      details: {
        runtimeMethod: "error",
        error: { message: "Model unavailable" },
      },
    }),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);
  const connection = timeline.filter((item) => item.title === "Connection lost" && item.kind === "status");
  const errors = timeline.filter((item) => item.kind === "error");

  assert.equal(connection.length, 1);
  assert.match(connection[0].body, /Reconnecting\.\.\. 3\/5/);
  assert.equal(errors.length, 1);
  assert.match(errors[0].body, /Model unavailable/);
});

function reconnectTraceEvent(id, timestamp, attempt) {
  return turnTrace(id, timestamp, "runtime_event", {
    runtimeMethod: "error",
    category: "connection",
    status: "retrying",
    summary: `connection retrying: Reconnecting... ${attempt}/5`,
    message: `Reconnecting... ${attempt}/5`,
    details: {
      runtimeMethod: "error",
      error: { message: `Reconnecting... ${attempt}/5`, additionalDetails: "request timed out" },
    },
  });
}

test("reconnect section resolves to Connection restored when the stream recovers", () => {
  const target = busyCodex;
  const events = [
    ...reconnectingTraceEvents([2, 3]),
    turnTrace("d1", "2026-05-21T00:00:04.000Z", "assistant_delta", {
      delta: "back to work",
    }),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);
  const restored = timeline.filter((item) => item.title === "Connection restored");

  assert.equal(restored.length, 1);
  assert.equal(restored[0].kind, "status");
  assert.equal(timeline.filter((item) => item.title === "Connection reconnecting").length, 0);
  assert.equal(timeline.filter((item) => item.kind === "error").length, 0);
  assert.equal(buildAgentTraceHeaderStatus(events), null);
});

test("reconnect section absorbs the turn failure as Connection lost", () => {
  const target = busyCodex;
  const events = [
    startedTurnTrace("s1", "2026-05-21T00:00:01.000Z", "do work"),
    reconnectTraceEvent("r5", "2026-05-21T00:00:02.000Z", 5),
    turnTrace("f1", "2026-05-21T00:00:03.000Z", "turn_failed", {
      error: "Codex app-server connection lost: no events for 180s after final reconnect attempt (Reconnecting... 5/5)",
    }),
  ];

  const timeline = buildAgentConversationTraceTimeline([], target, events);
  const lost = timeline.filter((item) => item.title === "Connection lost");

  assert.equal(lost.length, 1);
  assert.equal(lost[0].kind, "error");
  assert.match(lost[0].body, /connection lost/);
  assert.match(lost[0].body, /Resend the message to retry\./);
  assert.equal(timeline.filter((item) => item.title === "Error").length, 0);

  const headerStatus = buildAgentTraceHeaderStatus(events);
  assert.equal(headerStatus.tone, "error");
  assert.equal(headerStatus.title, "Connection lost");
});

test("buildAgentTraceHeaderStatus tracks reconnecting, failure, and clears on the next turn", () => {
  const target = busyCodex;
  void target;
  const started = startedTurnTrace("s1", "2026-05-21T00:00:01.000Z", "do work");
  const reconnecting = [started, reconnectTraceEvent("r2", "2026-05-21T00:00:02.000Z", 2)];
  const warning = buildAgentTraceHeaderStatus(reconnecting);
  assert.equal(warning.tone, "warning");
  assert.equal(warning.title, "Reconnecting");
  assert.match(warning.detail, /Reconnecting\.\.\. 2\/5/);

  const failed = [
    ...reconnecting,
    turnTrace("f1", "2026-05-21T00:00:03.000Z", "turn_failed", {
      error: "codex app-server turn/start failed",
    }),
  ];
  const errorStatus = buildAgentTraceHeaderStatus(failed);
  assert.equal(errorStatus.tone, "error");
  assert.equal(errorStatus.title, "Connection lost");

  const nextTurn = [
    ...failed,
    llmTrace("s2", "2026-05-21T00:00:10.000Z", "turn_started", {
      threadId: "thread-1",
      turnId: "turn-2",
      input: "try again",
    }),
  ];
  assert.equal(buildAgentTraceHeaderStatus(nextTurn), null);
});
