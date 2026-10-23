/** Shared desktop IPC shapes; native and browser adapters retain their distinct platform requirements. */

/**
 * Shapes the main process and the preload bridge both carry across IPC; the
 * renderer sees them through `window.xmatrixDesktop`.
 */

export type DesktopUpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "not-available"
  | "error"
  | "disabled";

export type DesktopUpdateStatus = {
  state: DesktopUpdateState;
  enabled: boolean;
  currentVersion: string;
  version?: string;
  percent?: number;
  message?: string;
  updatedAt: string;
};

export type DesktopDaemonState = "starting" | "running" | "stopped" | "missing" | "error";

export type DesktopDaemonStatus = {
  state: DesktopDaemonState;
  pid?: number;
  message?: string;
  /** Why the last start failed, until the daemon runs again. */
  failure?: DesktopDaemonFailure;
  updatedAt: string;
};

/**
 * Where starting the background service failed: installing the CLI from the
 * App's seed, asking the login-session manager (LaunchAgent, scheduled task)
 * to start it, the managed service not coming up, launching the process, or
 * the process exiting.
 */
export const DESKTOP_DAEMON_FAILURE_STAGES = ["cli_install", "service_start", "service_not_up", "spawn", "exit"] as const;
export type DesktopDaemonFailureStage = typeof DESKTOP_DAEMON_FAILURE_STAGES[number];

export type DesktopDaemonFailure = {
  stage: DesktopDaemonFailureStage;
  exitCode?: number;
  /** The last lines the CLI wrote, redacted on the machine and bounded. */
  detail: string;
};

/** What the App reports to the Hub about one failed start. */
export type DesktopDaemonFailureReport = DesktopDaemonFailure & { platform: string; appVersion: string };

export const DESKTOP_DAEMON_FAILURE_DETAIL_MAX = 600;

/** One report as a client sends it; anything else is not written. */
export function parseDesktopDaemonFailureReport(value: unknown): DesktopDaemonFailureReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const report = value as Record<string, unknown>;
  if (Object.keys(report).some(key => !["stage", "exitCode", "detail", "platform", "appVersion"].includes(key))) return undefined;
  if (!(DESKTOP_DAEMON_FAILURE_STAGES as readonly unknown[]).includes(report.stage)) return undefined;
  if (report.exitCode !== undefined && !Number.isSafeInteger(report.exitCode)) return undefined;
  const text = (key: string, max: number) => typeof report[key] === "string" ? (report[key] as string).slice(0, max) : undefined;
  const detail = text("detail", DESKTOP_DAEMON_FAILURE_DETAIL_MAX);
  const platform = text("platform", 16);
  const appVersion = text("appVersion", 32);
  if (detail === undefined || !platform || !appVersion) return undefined;
  return { stage: report.stage as DesktopDaemonFailureStage, detail, platform, appVersion,
    ...(report.exitCode !== undefined ? { exitCode: report.exitCode as number } : {}) };
}

export type DesktopSetupStatus = {
  setupVersion: number;
  completedAt?: string;
  updatedAt?: string;
};

export type DesktopAgentPresetInput = {
  id: string;
  displayName: string;
  runtime: string;
  backend: string;
  launcherNames?: string[];
  classicConfigDirs?: string[];
};

/** Result of installing the CLI from the App's bundled seed. */
export type DesktopCliInstallResult =
  | {
      ok: true;
      installedPath: string;
      version: string;
      daemon: { manager: string; definitionPath: string } | null;
    }
  | { ok: false; reason: "no-seed" | "install-failed"; message: string; exitCode?: number };

export type DesktopNotification = {
  title: string;
  body?: string;
  url?: string;
  channelId?: string;
  silent?: boolean;
  metadata?: Record<string, unknown>;
};

export type DesktopBadgeState = {
  /** How much is addressed to the person and unread. The app icon's badge shows it, and nothing at zero. */
  mentionCount: number;
};

export type DesktopNotificationReply = {
  channelId: string;
  body: string;
};

export type DesktopClipboardImage = {
  name?: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

export type DesktopCliSessionPayload = {
  token: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name?: string;
    avatarUrl?: string;
  };
  hubUrl: string;
  relayUrl: string;
};

export type DesktopWorkspaceCandidateFields = {
  path: string;
  canonicalCwd: string;
  displayName: string;
  machineId?: string;
  repoRoot?: string;
  gitRemote?: string;
  gitBranch?: string;
};

export type DesktopAgentPresetDiscoveryShape<Workspace> = {
  presetId: string;
  displayName: string;
  runtime: string;
  backend: string;
  runtimeAvailable: boolean;
  configDirs: string[];
  workspaces: Workspace[];
};
