import type { CliCall, CliCommand, CliOption } from "./cli-commands";
import { CliRouteError } from "./cli-commands";

/** `xmatrix automation …`: list and change Channel Automations through `/api/automations`. */

const json: CliOption = { name: "json", kind: "flag", help: "Print the Hub's JSON" };
const version: CliOption = { name: "version", aliases: ["expected-version"], kind: "integer", required: true,
  help: "The Automation version this change is based on" };
const reason: CliOption = { name: "reason", kind: "string", help: "Why, recorded with the change" };
const automationId = { name: "automation_id", help: "The Automation's id" };

const route = (id: string, action = "") => `/api/automations/${encodeURIComponent(id)}${action}`;
const printed = (value: unknown) => ({ stdout: `${JSON.stringify(value, null, 2)}\n` });

type Catalog = { automations?: Array<Record<string, unknown>>; agentManagementEnabled?: boolean };

async function catalog(call: CliCall, query = ""): Promise<Catalog> {
  const result = await call("GET", `/api/automations${query}`) as Catalog;
  if (!result.agentManagementEnabled) {
    throw new CliRouteError(426, "This Hub does not advertise Agent Automation management.");
  }
  return result;
}

/** A mutation is refused before it is sent when the caller may not manage Automations. */
async function mutate(call: CliCall, method: string, path: string, body: unknown) {
  await catalog(call);
  return printed(await call(method, path, body));
}

function versioned(options: Record<string, string | number | boolean>) {
  return { expectedVersion: options.version, ...(typeof options.reason === "string" ? { reason: options.reason } : {}) };
}

export const AUTOMATION_GROUP = { automation: "Create and manage Channel Automations" };

export const AUTOMATION_COMMANDS: CliCommand[] = [
  {
    path: ["automation", "list"], about: "List Automations visible in a Channel (or a managed Space)",
    options: [{ name: "channel", kind: "string", help: "The Channel whose Automations to list" },
      { name: "space", kind: "string", help: "The managed Space whose Automations to list" }, json],
    async run(call, { options }) {
      if ((options.channel === undefined) === (options.space === undefined)) {
        return { stdout: "", stderr: "error: automation list requires exactly one of --channel or --space\n", exitCode: 2 };
      }
      const query = typeof options.channel === "string" ? `?channelId=${encodeURIComponent(options.channel)}`
        : `?spaceId=${encodeURIComponent(String(options.space))}`;
      const automations = (await catalog(call, query)).automations ?? [];
      if (options.json) return printed(automations);
      return { stdout: automations.map((automation) => [automation.id ?? "unknown", `v${Number(automation.version) || 0}`,
        automation.enabled === true ? "active" : "paused", automation.name ?? "unnamed"].join("\t") + "\n").join("") };
    },
  },
  {
    path: ["automation", "update"], about: "Update an Automation without moving its Channel or changing its author",
    positionals: [automationId],
    options: [version, { name: "name", kind: "string", help: "New name" },
      { name: "expression", aliases: ["message"], kind: "string", help: "New task, in plain words" },
      { name: "every", aliases: ["interval-minutes"], kind: "integer", help: "New interval in minutes" }, reason, json],
    run: (call, { positionals, options }) => mutate(call, "PATCH", route(positionals.automation_id!), {
      ...versioned(options),
      ...(typeof options.name === "string" ? { name: options.name } : {}),
      ...(typeof options.expression === "string"
        ? { expression: { kind: "text", language: "natural-language", text: options.expression } } : {}),
      ...(typeof options.every === "number" ? { intervalMinutes: options.every } : {}),
    }),
  },
  {
    path: ["automation", "pause"], about: "Pause an Automation, or request Human approval when required",
    positionals: [automationId], options: [version, reason, json],
    run: (call, { positionals, options }) => mutate(call, "POST", route(positionals.automation_id!, "/pause"), versioned(options)),
  },
  {
    path: ["automation", "resume"], about: "Resume an Automation",
    positionals: [automationId], options: [version, reason, json],
    run: (call, { positionals, options }) => mutate(call, "POST", route(positionals.automation_id!, "/resume"), versioned(options)),
  },
  {
    path: ["automation", "cancel-execution"], about: "Cancel one exact execution as its Human owner; keep the Automation schedule",
    positionals: [automationId],
    options: [{ name: "run-id", kind: "string", required: true, help: "The execution's Run id" }, json],
    run: (call, { positionals, options }) => mutate(call, "POST", route(positionals.automation_id!, "/cancel-execution"),
      { runId: options["run-id"] }),
  },
  {
    path: ["automation", "delete"], about: "Delete an Automation lineage",
    positionals: [automationId], options: [version, reason, json],
    run: (call, { positionals, options }) => mutate(call, "DELETE", route(positionals.automation_id!), versioned(options)),
  },
];
