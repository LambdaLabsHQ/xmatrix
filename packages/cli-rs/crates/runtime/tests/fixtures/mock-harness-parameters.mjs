import readline from "node:readline";

const backend = process.argv[2];
let removed = false;
let acpBoolean = false;
const native = backend.startsWith("codex-native");
const settings = { serviceTier: "default", futureSpeed: "steady", futureQuiet: false, futureCount: 1 };
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (request, result) => send({ jsonrpc: "2.0", id: request.id, result });
const option = currentValue => ({ id: "future-speed", name: "Speed", type: "select", currentValue,
  options: ["turbo", "steady", "no-snapshot", "unconfirmed", "remove"].map(value => ({ value, name: value === "turbo" ? "Turbo speed" : value, description: "Native choice" })) });
const acpOptions = value => [option(value), { id:"quiet", name:"Quiet", description:"Reduce chatter", category:"model_config", type:"boolean", currentValue:acpBoolean }, { id:"stringSwitch", name:"Text switch", type:"select", currentValue:"off", options:[{value:"on",name:"On choice"},{value:"off",name:"Off choice"}] }];

readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  switch (request.method) {
    case "initialize":
      if (backend === "acp" && !request.params.clientCapabilities?.session?.configOptions?.boolean) throw new Error("Boolean capability was not declared");
      reply(request, {}); break;
    case "thread/start":
      reply(request, { thread: { id: "parameter-thread", model: "model" }, ...(native ? {serviceTier:settings.serviceTier} : {}) }); break;
    case "model/list":
      reply(request, { data: [{ id: "model", model: "model", displayName: "Model",
        supportedReasoningEfforts: [], serviceTiers: removed ? [] : [{ id: "future-priority", name: "Fast" }] }] });
      if (!native) removed = true;
      break;
    case "thread/settings/update": {
      if (!native || request.params.threadId !== "parameter-thread") throw new Error("Unexpected settings update");
      // A different thread's notification must never confirm the selection.
      send({ method: "thread/settings/updated", params: { threadId: "foreign-thread", threadSettings: request.params } });
      let changed = false;
      if (backend !== "codex-native-mismatch") {
        for (const key of Object.keys(settings)) {
          if (key in request.params) {
            const selected = request.params[key] ?? "default";
            changed ||= settings[key] !== selected;
            settings[key] = selected;
          }
        }
      }
      const notification = { method: "thread/settings/updated", params: { threadId: "parameter-thread", threadSettings: settings } };
      if (backend === "codex-native-before-response") send(notification);
      reply(request, {});
      if (backend !== "codex-native-before-response" && backend !== "codex-native-no-confirmation" &&
          (backend !== "codex-native-no-change" || changed)) send(notification);
      break;
    }
    case "turn/start": {
      const { threadId, serviceTier, futureSpeed, futureQuiet } = request.params;
      const turnId = "parameter-turn";
      reply(request, { turn: { id: turnId } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
      send({ method: "item/completed", params: { threadId, turnId,
        item: { id: "reply", type: "agentMessage", phase: "final_answer", text: JSON.stringify({ serviceTier, futureSpeed, futureQuiet }) } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      break;
    }
    case "session/new":
      reply(request, { sessionId: "parameter-session", configOptions: acpOptions("steady") }); break;
    case "session/set_config_option": {
      if (backend === "acp" && request.params.configId === "quiet") {
        if (request.params.type !== "boolean" || typeof request.params.value !== "boolean") throw new Error("Native boolean must be typed");
        acpBoolean = request.params.value;
        reply(request, {configOptions:acpOptions("steady")}); break;
      }
      if (backend !== "acp" || request.params.type !== undefined || request.params.sessionId !== "parameter-session" || request.params.configId !== "future-speed" ||
          !option("steady").options.some(o => o.value === request.params.value)) throw new Error("Unexpected native parameter request");
      const value = request.params.value;
      reply(request, value === "no-snapshot" ? {} : { configOptions: value === "remove" ? [] : acpOptions(value === "unconfirmed" ? "steady" : value) });
      break;
    }
    default:
      if (request.id !== undefined) reply(request, {});
  }
});
