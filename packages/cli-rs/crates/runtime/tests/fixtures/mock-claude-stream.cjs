const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.argv[2];
const stdinLog = mode === "commands" ? null : process.argv[3];
let userTurns = 0;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (stdinLog) fs.appendFileSync(stdinLog, `${line}\n`);
  const message = JSON.parse(line);
  if (message.type === "user") {
    userTurns += 1;
    send({
      type: "system",
      subtype: "init",
      session_id: "fake-session",
      slash_commands: mode === "commands" ? ["goal", "compact", "ship-it"] : mode === "self-goal" ? ["goal"] : [],
    });
    // The first interrupt-mode turn stays active until its native interrupt.
    if (mode !== "interrupt" || userTurns > 1) {
      send({
        type: "result",
        session_id: "fake-session",
        result: mode === "self-goal" ? "Goal set: keep the suite green" : mode === "commands" ? "done" : `turn ${userTurns} done`,
      });
    }
    return;
  }
  if (mode === "interrupt" && message.type === "control_request" && message.request?.subtype === "interrupt") {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response: { still_queued: [] } },
    });
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "fake-session",
      result: "interrupted by a newer channel message",
    });
  }
});
