import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const mode = process.argv[2] ?? "antigravity";
const sessionId = "waiting-session";
const emit = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const respond = (req, result) => emit({ jsonrpc: "2.0", id: req.id, result });
const notify = (update) =>
  emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

async function runPrompt(req) {
  if (mode === "antigravity-subagent" || mode === "antigravity-subagent-killed") {
    const brainDir = path.join(process.env.ANTIGRAVITY_APP_DATA_DIR, "brain");
    const childId = "subagent-child-1";
    const subagentFile = path.join(
      brainDir,
      sessionId,
      ".system_generated",
      "subagents",
      `${childId}.json`,
    );
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "call-subagent-async",
      name: "invoke_subagent",
      title: "Run invoke_subagent",
      status: "in_progress",
      rawInput: { TypeName: "self", Role: "Researcher", Prompt: "Write report" },
    });
    writeJson(subagentFile, {
      conversationId: childId,
      subagentDescriptor: { typeName: "self", role: "Researcher" },
      state: "SUBAGENT_STATE_ALIVE",
    });
    writeJson(
      path.join(brainDir, childId, ".system_generated", "messages", "assign-1.json"),
      {
        id: "assign-1",
        sender: sessionId,
        recipient: childId,
        timestamp: "2026-11-20T09:10:00Z",
      },
    );
    // Real agy acp marks invoke_subagent completed immediately upon spawn.
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-subagent-async",
      name: "invoke_subagent",
      status: "completed",
    });
    notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Launched subagent." },
    });
    respond(req, { stopReason: "end_turn" });

    if (mode === "antigravity-subagent-killed") {
      setTimeout(() => {
        writeJson(subagentFile, {
          conversationId: childId,
          subagentDescriptor: { typeName: "self", role: "Researcher" },
          state: "SUBAGENT_STATE_KILLED",
        });
      }, 140);
      return;
    }

    setTimeout(() => {
      const parentMessages = path.join(brainDir, sessionId, ".system_generated", "messages");
      writeJson(path.join(parentMessages, "rep-1.json"), {
        id: "rep-1",
        sender: childId,
        recipient: sessionId,
        timestamp: "2026-11-20T09:10:15Z",
        content: "Report complete.",
      });
      writeJson(path.join(parentMessages, "read.json"), { "rep-1": true });
      // Delay the first reactive token slightly to exercise the wakeup grace window.
      setTimeout(() => {
        notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "\n\nSubagent report ready." },
        });
        notify({ sessionUpdate: "usage_update", used: 9600, size: 1048576 });
      }, 90);
    }, 150);
    return;
  }
  if (mode === "pr-activity") {
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "call-pr-1",
      name: "run_command",
      title: "Create PR",
      status: "in_progress",
      rawInput: { CommandLine: "gh pr create --title 'ACP activity' --body 'body'" },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-pr-1",
      name: "run_command",
      status: "completed",
      rawOutput: "Creating pull request\nhttps://github.com/LambdaLabsHQ/xmatrix/pull/1969\n",
    });
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "call-view-1",
      name: "run_command",
      title: "View PR",
      status: "in_progress",
      rawInput: { CommandLine: "gh pr view 1969" },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-view-1",
      name: "run_command",
      status: "completed",
      rawOutput: "https://github.com/LambdaLabsHQ/xmatrix/pull/1970\n",
    });
    respond(req, { stopReason: "end_turn" });
    return;
  }
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
