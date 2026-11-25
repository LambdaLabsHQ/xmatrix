import agentPresets from "./agent-presets.json" with { type: "json" };

/**
 * The Agent harness registry. `agent-presets.json` is the single source of
 * truth shared with the Rust CLI (`include_str!`); every launcher alias,
 * backend, config directory, and install hint lives there so adding a harness
 * is a data change, not a code change.
 */
export type AgentPresetId =
  | "codex"
  | "claude"
  | "grok"
  | "kimi"
  | "cursor"
  | "opencode"
  | "pi"
  | "copilot"
  | "gemini"
  | "qwen"
  | "goose"
  | "junie"
  | "vibe"
  | "kiro"
  | "hermes"
  | "openclaw"
  | "qoder"
  | "codebuddy"
  | "omp"
  | "auggie"
  | "cline"
  | "kilo"
  | "droid"
  | "devin"
  | "commandcode"
  | "jcode"
  | "prime"
  | "trae"
  | "antigravity"
  | "autohand"
  | "amp"
  | "reasonix"
  | "dimcode"
  | "deepseek"
  | "custom";
export type AgentPresetBackend =
  | "codex-app"
  | "claude-print"
  | "grok-acp"
  | "acp"
  | "pty";

export const AGENT_PRESET_BACKENDS = new Set<AgentPresetBackend>([
  "codex-app", "claude-print", "grok-acp", "acp", "pty",
]);

/**
 * What xMatrix adds to a harness launch in one access mode. `args` join the
 * launcher's argv (the ACP argv for the generic ACP backend), `env` is set on
 * the harness process, and `session` values are sent when its native session
 * starts (Codex `thread/start`).
 */
export interface AgentPresetAccess {
  args?: string[];
  env?: Record<string, string>;
  session?: Record<string, string>;
}

/**
 * How much a registration's Runs may do on its machine without asking. `full`
 * launches the harness with everything in its preset's `access.full` and
 * answers its permission requests with allow; `ask` adds nothing, so the
 * harness keeps its vendor defaults. The machine's owner chooses when adding
 * the Agent.
 */
export type AgentAccessMode = "full" | "ask";
export const AGENT_ACCESS_MODES: readonly AgentAccessMode[] = ["full", "ask"];

/** Exactly what one launch adds for its access mode: the data the daemon
 * applies and the same data the owner is shown before confirming. */
export interface AgentAccessGrant {
  mode: AgentAccessMode;
  args: string[];
  env: Record<string, string>;
  session: Record<string, string>;
  /** xMatrix answers the harness's permission requests with allow. */
  approvesRequests: boolean;
}

export interface AgentPreset {
  id: AgentPresetId;
  displayName: string;
  description: string;
  runtime: string;
  /**
   * Legacy `agentType` string registered for this harness when it differs
   * from the preset id (`claude` → `claude_code`). Absent means the id.
   */
  agentType?: string;
  avatarUrl?: string;
  defaultArgs: string[];
  /** What xMatrix adds to this harness's launch per access mode, exactly as
   * written: what a person is shown and what the launch sets are the same
   * data. See `agentAccessGrant`. */
  access?: { full?: AgentPresetAccess };
  backend: AgentPresetBackend;
  /**
   * Subcommand/args appended to the runtime for the generic ACP backend
   * (e.g. `["acp"]` → `kimi acp`). Propagated to daemon spawns as the
   * XMATRIX_ACP_ARGS JSON array. An explicit `[]` means the launcher already
   * speaks ACP with no subcommand; absent defaults to `["acp"]`.
   */
  acpArgs?: string[];
  launcherNames: string[];
  classicConfigDirs: string[];
  /** One-line upstream installer, shown when the runtime binary is missing. */
  installHint?: string;
  management?: import("./harness-management.js").HarnessManagement;
}

export const AGENT_PRESETS = agentPresets as AgentPreset[];

/** A harness xMatrix explicitly refuses to register, manage, or run. */
export interface RefusedAgentHarness {
  readonly id: string;
  readonly displayName: string;
  readonly launcherStems: readonly string[];
  readonly backends: readonly string[];
  readonly reason: string;
  readonly docsUrl: string;
}

export const REFUSED_AGENT_HARNESSES: readonly RefusedAgentHarness[] = [
  {
    id: "zcode",
    displayName: "ZCode",
    launcherStems: ["zcode", "zcode.cjs", "zcode-acp", "acp-extension-zcode"],
    backends: ["zcode-app"],
    reason:
      "xMatrix explicitly refuses ZCode: its app-server requires host-side provider credentials and its history of unannounced workspace uploads crosses xMatrix's privacy boundary. Use another supported harness instead.",
    docsUrl: "https://xmatrix.page/docs/agents#unsupported-harnesses",
  },
];

export const REFUSED_AGENT_BACKENDS = new Set<string>(
  REFUSED_AGENT_HARNESSES.flatMap((entry) => entry.backends),
);

export function refusedAgentHarness(
  runtimeOrType?: string | null,
): RefusedAgentHarness | undefined {
  const raw = runtimeOrType?.trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const stem = agentLauncherStem(raw);
  return REFUSED_AGENT_HARNESSES.find(
    (entry) =>
      entry.id === stem ||
      entry.launcherStems.includes(stem) ||
      entry.backends.includes(lower),
  );
}

export function refusedAgentHarnessMessage(
  runtimeOrType?: string | null,
): string | undefined {
  const entry = refusedAgentHarness(runtimeOrType);
  return entry ? `${entry.reason} (${entry.docsUrl})` : undefined;
}

export function agentPresetById(id: string | undefined | null): AgentPreset | undefined {
  return AGENT_PRESETS.find((preset) => preset.id === id);
}

/** Lowercase launcher stem: drops directories and Windows launcher extensions. */
function agentLauncherStem(value: string): string {
  const fileName = value.replace(/\\/g, "/").split("/").pop() || value;
  return fileName.toLowerCase().replace(/\.(exe|cmd|bat)$/u, "");
}

/**
 * The preset a launcher token, runtime path, preset id, or legacy agentType
 * belongs to (`cursor-agent.exe` → cursor, `claude_code` → claude,
 * `pi-acp` → pi). `custom` never matches: it has no launcher of its own.
 */
export function agentPresetForLauncher(
  runtimeOrType?: string | null,
): AgentPreset | undefined {
  const raw = runtimeOrType?.trim();
  if (!raw) return undefined;
  const stem = agentLauncherStem(raw);
  return AGENT_PRESETS.find(
    (preset) =>
      preset.id !== "custom" &&
      (preset.id === stem ||
        preset.agentType === stem ||
        agentLauncherStem(preset.runtime) === stem ||
        preset.launcherNames.some((launcher) => agentLauncherStem(launcher) === stem)),
  );
}

/**
 * The executable a declared launch runtime names. A harness key -- a preset id
 * or legacy agentType (`claude_code`, `cursor`, `pi`) -- names a preset, never
 * an executable, so it resolves to that preset's runtime. Every other launcher
 * token or path is the executable exactly as declared.
 */
export function agentLaunchExecutable(runtime: string): string {
  const preset = AGENT_PRESETS.find(
    (candidate) => candidate.id !== "custom" && (candidate.id === runtime || candidate.agentType === runtime),
  );
  return preset?.runtime ?? runtime;
}

/**
 * Map launcher / agentType aliases onto the preset id used for vendor icons
 * and presentation labels (`cursor-agent` → `cursor`, `claude_code` → `claude`).
 * Unknown runtimes pass through unchanged.
 */
export function normalizeAgentPresetRuntime(
  runtimeOrType?: string | null,
): string | undefined {
  const raw = runtimeOrType?.trim();
  if (!raw) return undefined;
  return agentPresetForLauncher(raw)?.id ?? raw;
}

/**
 * The launch-relevant part of a preset, as the Hub sends it on every
 * `machine_spawn_agent`. The Hub is the only preset authority: a daemon uses
 * this spec instead of any copy compiled into it. Presentation fields stay
 * behind; the install hint travels because the daemon shows it when the
 * launcher is missing.
 */
/** The backends whose bridge receives the harness's permission requests
 * (ACP `session/request_permission`, Claude `can_use_tool`): in `full` it
 * answers them with allow, in `ask` it shows each as a card in the Channel
 * and waits. A harness on another backend can only be given `full`. */
const REQUEST_RELAYING_BACKENDS = new Set<AgentPresetBackend>(["acp", "grok-acp", "claude-print"]);

/** The access modes a harness can be added with, the default first.
 *
 * A harness whose full access is an environment setting keeps its limit in
 * its own sandbox: a refused write fails the command outright and sends no
 * request. Left on its default, DeepSeek Harness cannot write
 * `~/.config/xmatrix`, so no `xmatrix` command runs in its shell and the
 * Agent could not answer in its Channel. Such a harness is offered full
 * access alone. */
export function agentAccessModes(preset: AgentPreset | undefined): AgentAccessMode[] {
  if (!preset || !REQUEST_RELAYING_BACKENDS.has(preset.backend)) return ["full"];
  return Object.keys(preset.access?.full?.env ?? {}).length ? ["full"] : ["full", "ask"];
}

/** A daemon with this capability shows an `ask` launch's permission requests
 * in its Channel. An earlier one answers them all with allow, so an `ask`
 * launch is never routed to it. */
export const REGISTRATION_ACCESS_ASK_CAPABILITY = "registration_access_ask_v1";

export function agentAccessGrant(preset: AgentPreset | undefined, mode: AgentAccessMode): AgentAccessGrant {
  const added = mode === "full" ? preset?.access?.full : undefined;
  return {
    mode,
    args: [...(added?.args ?? [])],
    env: { ...added?.env },
    session: { ...added?.session },
    approvesRequests: mode === "full" && preset !== undefined && REQUEST_RELAYING_BACKENDS.has(preset.backend),
  };
}

export interface AgentHarnessSpec {
  id: AgentPresetId;
  runtime: string;
  agentType: string;
  backend: AgentPresetBackend;
  defaultArgs: string[];
  acpArgs?: string[];
  launcherNames: string[];
  classicConfigDirs: string[];
  installHint?: string;
}

export function agentHarnessSpec(
  presetId?: string | null,
  runtime?: string | null,
): AgentHarnessSpec | undefined {
  const preset = agentPresetById(presetId ?? undefined) ?? agentPresetForLauncher(runtime);
  if (!preset || preset.id === "custom") return undefined;
  return {
    id: preset.id,
    runtime: preset.runtime,
    agentType: preset.agentType ?? preset.id,
    backend: preset.backend,
    defaultArgs: [...preset.defaultArgs],
    ...(preset.acpArgs ? { acpArgs: [...preset.acpArgs] } : {}),
    launcherNames: [...preset.launcherNames],
    classicConfigDirs: [...preset.classicConfigDirs],
    ...(preset.installHint ? { installHint: preset.installHint } : {}),
  };
}

/** The Hub is the only preset authority: every delivered `machine_spawn_agent`
 * carries its harness spec, whichever channel (socket claim or HTTP control
 * poll) delivers it. A registered launch is refused by the daemon without one. */
export function withMachineSpawnHarness<T>(command: T): T {
  if (!command || typeof command !== "object" || Array.isArray(command)) return command;
  const payload = command as Record<string, unknown>;
  if (payload.type !== "machine_spawn_agent" || payload.harness !== undefined) return command;
  const harness = agentHarnessSpec(
    typeof payload.agentPresetId === "string" ? payload.agentPresetId : undefined,
    typeof payload.runtime === "string" ? payload.runtime : undefined,
  );
  return (harness ? { ...payload, harness } : command) as T;
}
