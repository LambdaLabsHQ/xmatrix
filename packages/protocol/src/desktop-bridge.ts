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
  updatedAt: string;
};

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
  | { ok: false; reason: "no-seed" | "install-failed"; message: string };

export type DesktopNotification = {
  title: string;
  body?: string;
  url?: string;
  channelId?: string;
  silent?: boolean;
  metadata?: Record<string, unknown>;
};

export type DesktopBadgeState = {
  /** Count of unread mentions / direct attention. Drives the numeric dock badge (Slack-style). */
  mentionCount: number;
  /** Whether any channel has unread activity without a mention. Drives the dot-only badge. */
  hasUnread: boolean;
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
