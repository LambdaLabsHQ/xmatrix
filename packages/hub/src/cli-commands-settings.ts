import { HUB_ROUTES, SETTING_ADDRESS_FORMS, type SettingDescriptor } from "@xmatrix/protocol";
import type { CliCommand, CliOutput } from "./cli-commands";

const ADDRESSES = `Setting addresses: ${SETTING_ADDRESS_FORMS.join(", ")}`;

/** One line per setting: address, state, and who makes it; a value is never printed. */
function settingLines(settings: readonly SettingDescriptor[]): string {
  return settings.map((setting) => `${setting.address}\t${setting.satisfied ? "in" : setting.state}\t${setting.scope}: ${setting.label}` +
    `${setting.problem ? ` (${setting.problem})` : ""}`).join("\n");
}

/** `<address>=<value>` suggestions as the Hub takes them; the value may itself hold `=`. */
function proposals(items: readonly string[]): Record<string, string> | string {
  const map: Record<string, string> = {};
  for (const item of items) {
    const at = item.indexOf("=");
    const address = item.slice(0, at).trim(), value = item.slice(at + 1).trim();
    if (at < 1 || !address || !value) return `--propose takes <address>=<value>, such as connector:appstoreconnect/vendorNumber=87654321; got ${item}`;
    map[address] = value;
  }
  return map;
}

const usage = (stderr: string): CliOutput => ({ stdout: "", stderr: `error: ${stderr}\n`, exitCode: 2 });

/**
 * `xmatrix settings …`: an Agent asks, on a card in its Channel, for settings
 * only a person can make, and reads where they stand. Defined on the Hub, so
 * every CLI that passes unknown words to the Hub has it, and the addresses it
 * takes are whatever the Hub's settings registry holds.
 */
export const SETTINGS_COMMANDS: CliCommand[] = [
  {
    path: ["settings", "ask"],
    about: "Ask, on a card in this Channel, for settings only a person can make; you are woken once they are in",
    positionals: [{ name: "setting", variadic: true, help: `Setting addresses, e.g. connector:appstoreconnect/webSession. ${ADDRESSES}` }],
    options: [{ name: "reason", kind: "string", help: "Why you need them, shown on the card" },
      { name: "propose", kind: "string", repeatable: true,
        help: "Suggest a value for a plain setting (never a secret), which a person confirms: <address>=<value>" },
      { name: "json", kind: "flag", help: "Print the Hub's answer as JSON" }],
    async run(call, { lists, options }) {
      const suggested = proposals(lists.propose ?? []);
      if (typeof suggested === "string") return usage(suggested);
      const answer = await call("POST", HUB_ROUTES.settings_requests, { settings: lists.setting, proposals: suggested,
        requestId: crypto.randomUUID(), ...(typeof options.reason === "string" ? { reason: options.reason } : {}) }) as
        { settings: string[]; descriptors: SettingDescriptor[] };
      if (options.json) return { stdout: `${JSON.stringify(answer)}\n` };
      return { stdout: `Asked on a card in this Channel. When every setting is in, xMatrix answers the card and wakes you; ` +
        `until then, go on with other work or end your turn.\n${settingLines(answer.descriptors)}\n` };
    },
  },
  {
    path: ["settings", "status"],
    about: "Show where settings stand: missing, set, verified, invalid, or in as asked",
    positionals: [{ name: "setting", variadic: true, help: `Setting addresses. ${ADDRESSES}` }],
    options: [{ name: "since", kind: "string", help: "When they were asked for (ISO time); in means made after it" },
      { name: "json", kind: "flag", help: "Print the Hub's answer as JSON" }],
    async run(call, { lists, options }) {
      const query = new URLSearchParams((lists.setting ?? []).map((setting) => ["setting", setting]));
      if (typeof options.since === "string") query.set("since", options.since);
      const answer = await call("GET", `${HUB_ROUTES.settings_request_status}?${query}`) as
        { settled: boolean; settings: SettingDescriptor[] };
      return { stdout: options.json ? `${JSON.stringify(answer)}\n` : `${settingLines(answer.settings)}\n` };
    },
  },
];

export const SETTINGS_GROUP: Record<string, string> = {
  settings: "Ask for settings only a person can make (sign-ins, credentials, secrets, harness logins) and see where they stand",
};
