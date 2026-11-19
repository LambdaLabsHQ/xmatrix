import readline from "node:readline";

const mode = process.argv[2] ?? "antigravity";
const sessionId = "waiting-session";
const emit = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const respond = (req, result) => emit({ jsonrpc: "2.0", id: req.id, result });
const notify = (update) =>
  emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runPrompt(req) {
  if (mode === "unclosed-tool") {
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "call-grok-1",
      title: "bash",
      status: "in_progress",
      rawInput: { command: "gh pr checks 9 --watch" },
    });
    await sleep(260);
    respond(req, { stopReason: "end_turn" });
    return;
  }
  // 1. Subagent call open past threshold must not read as a wait.
  notify({
    sessionUpdate: "tool_call",
    toolCallId: "call-subagent",
    name: "invoke_subagent",
    title: "Run invoke_subagent",
    status: "in_progress",
    rawInput: { Role: "Helper", Prompt: "Check status" },
  });
  await sleep(240);
  notify({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-subagent",
    name: "invoke_subagent",
    status: "completed",
  });
  // 2. Long foreground command crosses the wait threshold, then completes.
  notify({
    sessionUpdate: "tool_call",
    toolCallId: "call-fg",
    name: "run_command",
    title: "gh pr checks 7 --watch",
    status: "in_progress",
    rawInput: { CommandLine: "gh pr checks 7 --watch", toolSummary: "Wait for CI" },
  });
  await sleep(260);
  notify({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-fg",
    name: "run_command",
    status: "completed",
  });
  // 3. Daemon tool + background schedule both stay open across end_turn.
  notify({
    sessionUpdate: "tool_call",
    toolCallId: "call-daemon",
    name: "run_command",
    title: "pnpm dev",
    status: "in_progress",
    rawInput: { CommandLine: "pnpm dev", IsDaemon: true, toolSummary: "Dev server" },
  });
  notify({
    sessionUpdate: "tool_call",
    toolCallId: "call-bg-timer",
    name: "schedule",
    title: "Run schedule",
    status: "in_progress",
    rawInput: { DurationSeconds: 300, Prompt: "Check PR #1816 CI" },
  });
  notify({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Waiting on timer." },
  });
  respond(req, { stopReason: "end_turn" });
  // 4. After end_turn, background timer finishes and triggers reactive wakeup.
  setTimeout(() => {
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-bg-timer",
      name: "schedule",
      status: "completed",
    });
    setTimeout(() => {
      notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\n\nCI green." },
      });
      notify({ sessionUpdate: "usage_update", used: 9500, size: 1048576 });
    }, 60);
  }, 150);
}

const rpcHandlers = {
  initialize: (req) => respond(req, {}),
  authenticate: (req) => respond(req, {}),
  "session/new": (req) => respond(req, { sessionId }),
  "session/prompt": runPrompt,
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  await rpcHandlers[req.method]?.(req);
}
