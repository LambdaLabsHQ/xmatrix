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
  | "zcode"
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
  | "custom";
export type AgentPresetBackend =
  | "codex-app"
  | "claude-print"
  | "zcode-app"
  | "grok-acp"
  | "acp"
  | "pty";

export const AGENT_PRESET_BACKENDS = new Set<AgentPresetBackend>([
  "codex-app", "claude-print", "zcode-app", "grok-acp", "acp", "pty",
]);

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

export function agentPresetById(id: string | undefined | null): AgentPreset | undefined {
  return AGENT_PRESETS.find((preset) => preset.id === id);
}

export function agentPresetAvatarUrl(id: string | undefined | null): string | undefined {
  return agentPresetById(id)?.avatarUrl;
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
