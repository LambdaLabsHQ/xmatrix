import readline from "node:readline";

const mode = process.argv[2] ?? "antigravity";
const sessionId = "waiting-session";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (request, result) => send({ jsonrpc: "2.0", id: request.id, result });
const update = (value) => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId, update: value },
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
    case "authenticate":
      reply(message, {});
      break;
    case "session/new":
      reply(message, { sessionId });
      break;
    case "session/prompt":
      if (mode === "unclosed-tool") {
        update({
          sessionUpdate: "tool_call",
          toolCallId: "call-grok-1",
          title: "bash",
          status: "in_progress",
          rawInput: { command: "gh pr checks 9 --watch" },
        });
        await delay(260);
        reply(message, { stopReason: "end_turn" });
        break;
      }
      // 1. Subagent call open past threshold must not read as a wait.
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call-subagent",
        name: "invoke_subagent",
        title: "Run invoke_subagent",
        status: "in_progress",
        rawInput: { Role: "Helper", Prompt: "Check status" },
      });
      await delay(240);
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-subagent",
        name: "invoke_subagent",
        status: "completed",
      });
      // 2. Long foreground command crosses the wait threshold, then completes.
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call-fg",
        name: "run_command",
        title: "gh pr checks 7 --watch",
        status: "in_progress",
        rawInput: {
          CommandLine: "gh pr checks 7 --watch",
          toolSummary: "Wait for CI",
        },
      });
      await delay(260);
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-fg",
        name: "run_command",
        status: "completed",
      });
      // 3. Daemon tool + background schedule both stay open across end_turn.
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call-daemon",
        name: "run_command",
        title: "pnpm dev",
        status: "in_progress",
        rawInput: {
          CommandLine: "pnpm dev",
          IsDaemon: true,
          toolSummary: "Dev server",
        },
      });
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call-bg-timer",
        name: "schedule",
        title: "Run schedule",
        status: "in_progress",
        rawInput: {
          DurationSeconds: 300,
          Prompt: "Check PR #1816 CI",
        },
      });
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Waiting on timer." },
      });
      reply(message, { stopReason: "end_turn" });
      // 4. After end_turn, background timer finishes and triggers reactive wakeup.
      setTimeout(() => {
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-bg-timer",
          name: "schedule",
          status: "completed",
        });
        setTimeout(() => {
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "\n\nCI green." },
          });
          update({
            sessionUpdate: "usage_update",
            used: 9500,
            size: 1048576,
          });
        }, 60);
      }, 150);
      break;
  }
});
