import readline from "node:readline";

let fast = false, style = "default", styles = ["default", "future-style", "remove"];
const blocked = process.argv.includes("blocked"), cooldown = process.argv.includes("cooldown");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const value = JSON.parse(line);
  if (value.type === "user") throw new Error("Parameter control must not submit task text");
  if (value.type !== "control_request") return;
  const request = value.request;
  let response = {};
  if (request.subtype === "initialize") response = {
    models: [{ value: "default", resolvedModel: "native-model", supportsFastMode: true,
      supportedEffortLevels: ["low", "future-effort"] }],
    fast_mode_state: fast && !blocked ? (cooldown ? "cooldown" : "on") : "off",
    ...(blocked ? { fast_mode_disabled_reason: "extra_usage_disabled" } : {}),
    output_style: style, available_output_styles: styles,
    account: { email: "private@example.com" }
  };
  if (request.subtype === "apply_flag_settings") {
    if (Object.hasOwn(request.settings, "fastMode")) fast = request.settings.fastMode;
    if (Object.hasOwn(request.settings, "outputStyle")) {
      style = request.settings.outputStyle;
      if (style === "remove") styles = [];
    }
  }
  console.log(JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: value.request_id, response
  } }));
});
