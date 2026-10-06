import readline from "node:readline";

const mode = process.argv[2] ?? "resume";
const sessionId = "loaded-session";
let loadRequest;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (request, result) => send({ jsonrpc: "2.0", id: request.id, result });
const update = (value, target = sessionId) => send({
  jsonrpc: "2.0", method: "session/update",
  params: { sessionId: target, update: value },
});

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
    case "authenticate":
      reply(message, {});
      break;
    case "session/new":
      if (mode === "new-overflow") {
        for (let i = 0; i < 1200; i++) {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } });
        }
      }
      reply(message, { sessionId: "new-session" });
      break;
    case "session/load":
      loadRequest = message;
      if (message.params.sessionId !== sessionId) throw new Error("wrong resume pointer");
      // Preserve unrelated notifications and responses in their original order.
      send({ jsonrpc: "2.0", method: "vendor/notice", params: { value: "keep" } });
      send({ jsonrpc: "2.0", id: 999, result: { value: "keep" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "foreign" } }, "other-session");
      for (let i = 0; i < 1200; i++) {
        update({
          sessionUpdate: i % 2 ? "agent_thought_chunk" : "agent_message_chunk",
          content: { type: "text", text: "historical output" },
        }, mode === "foreign-overflow" ? "other-session" : sessionId);
      }
      // The peer cannot finish loading until the bridge answers this request.
      send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission",
        params: { sessionId, options: [{ optionId: "approve", kind: "allow_once" }] } });
      break;
    case "session/prompt":
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live reply" } }, message.params.sessionId);
      reply(message, { stopReason: "end_turn" });
      break;
    default:
      if (message.id === "permission") {
        if (message.result?.outcome?.optionId !== "approve") throw new Error("permission lost");
        for (let i = 0; i < 1000; i++) {
          update({ sessionUpdate: "tool_call_update", toolCallId: `old-${i}`, status: "completed" });
        }
        update({ sessionUpdate: "current_model_update", currentModelId: "restored-model", reasoningEffort: "high" });
        update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "restored", description: "Restored command" }] });
        update({ sessionUpdate: "usage_update", used: 8192, size: 131072, cost: { currency: "USD", amount: 0.0042 } });
        update({ sessionUpdate: "tool_call", title: "update_goal", rawInput: { objective: "Old goal", status: "active" } });
        update({ sessionUpdate: "tool_call_update", title: "update_goal", rawInput: { objective: "Restored goal", status: "paused" } });
        send({ jsonrpc: "2.0", id: "unsupported", method: "fs/read_text_file", params: { path: "/unavailable" } });
      } else if (message.id === "unsupported") {
        if (message.error?.code !== -32601) throw new Error("unsupported capability accepted");
        if (mode === "load-error") {
          send({ jsonrpc: "2.0", id: loadRequest.id, error: { code: -32602, message: "Session unavailable" } });
        } else {
          reply(loadRequest, { sessionId });
        }
      }
  }
});
