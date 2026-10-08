"use client";
import type { DesktopUpdateStatus, DesktopDaemonStatus, DesktopCliInstallResult, DesktopSetupStatus, DesktopClipboardImage, DesktopCliSessionPayload, DesktopNotification, DesktopBadgeState, DesktopNotificationReply, DesktopAgentPresetInput, DesktopWorkspaceCandidateFields, DesktopAgentPresetDiscoveryShape } from "@xmatrix/protocol";
export type { DesktopUpdateStatus, DesktopDaemonStatus, DesktopCliInstallResult, DesktopSetupStatus, DesktopClipboardImage, DesktopCliSessionPayload } from "@xmatrix/protocol";

type NativeBridgeClient = "desktop" | "ios" | "android" | string;
type NativeBridgePlatform = NodeJS.Platform | "ios" | "android" | string;

export type DesktopContext = {
  client?: NativeBridgeClient;
  platform: NativeBridgePlatform;
  machineId?: string;
  hostId?: string;
  hostName?: string;
  hostname?: string;
  version: string;
  isPackaged: boolean;
  startUrl: string;
};

type DesktopNotificationPermission =
  | "granted"
  | "denied"
  | "not-determined"
  | "provisional"
  | "ephemeral"
  | "unsupported";

type DesktopNotificationStatus = {
  supported: boolean;
  permission: DesktopNotificationPermission;
  alert?: boolean;
  badge?: boolean;
  sound?: boolean;
};

export type DesktopWorkspaceCandidate = DesktopWorkspaceCandidateFields & { hostId?: string; hostName?: string; hostname?: string };

export type DesktopAgentPresetDiscovery = DesktopAgentPresetDiscoveryShape<DesktopWorkspaceCandidate>;

type DesktopPathValidationResult = {
  ok: boolean;
  path?: string;
  canonicalCwd?: string;
  displayName?: string;
  error?: string;
};

export type DesktopRuntimeCheckResult = {
  ok: boolean;
  runtime: string;
  path?: string;
  version?: string;
  error?: string;
};

export type ApplePurchaseTransaction = {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  environment: "Production" | "Sandbox";
};

export type DesktopBridge = {
  appleProducts?: (productIds: string[]) => Promise<{ id: string; displayName: string; displayPrice: string }[]>;
  applePurchase?: (input: { productId: string; appAccountToken: string; productIds: string[] }) => Promise<{
    status: "purchased" | "pending" | "cancelled"; transaction?: ApplePurchaseTransaction;
  }>;
  applePurchases?: (input: { productIds: string[]; restore: boolean }) => Promise<ApplePurchaseTransaction[]>;
  appleFinish?: (transactionId: string) => Promise<void>;
  appleManage?: () => Promise<void>;
  client?: NativeBridgeClient;
  platform: NativeBridgePlatform;
  getContext: () => Promise<DesktopContext>;
  setBadge: (state: DesktopBadgeState) => Promise<void>;
  setTitle: (title: string) => Promise<void>;
  /**
   * Open an in-app route in a second shell window, so one user can work in two
   * Spaces at once. Resolves false when the shell refuses the path. Absent on
   * web and on shells older than multi-window support.
   */
  openWindow?: (path?: string) => Promise<boolean>;
  getNotificationSettings?: () => Promise<DesktopNotificationStatus>;
  requestNotifications?: () => Promise<DesktopNotificationStatus>;
  notify: (payload: DesktopNotification) => Promise<boolean | void>;
  openExternal: (url: string) => Promise<void>;
  getClipboardImages?: () => Promise<DesktopClipboardImage[]>;
  /** Write an image onto the OS clipboard via Electron nativeImage. */
  writeClipboardImage?: (image: DesktopClipboardImage) => Promise<void>;
  checkCliInstalled: () => Promise<{ installed: boolean; version?: string }>;
  saveCliSession?: (payload: DesktopCliSessionPayload) => Promise<{
    ok: boolean;
    machineId?: string;
    updatedAt: string;
  }>;
  refreshCliSession?: (payload: DesktopCliSessionPayload) => Promise<{
    ok: boolean;
    machineId?: string;
    updatedAt: string;
  }>;
  switchEnvironment?: (environment: "production" | "test") => Promise<{ environment: "production" | "test" }>;
  openCliInstall: () => Promise<void>;
  /** Install the CLI from the App's bundled seed and register the daemon. */
  installCli?: () => Promise<DesktopCliInstallResult>;
  getDaemonStatus?: () => Promise<DesktopDaemonStatus>;
  startDaemon?: () => Promise<DesktopDaemonStatus>;
  stopDaemon?: () => Promise<DesktopDaemonStatus>;
  restartDaemon?: () => Promise<DesktopDaemonStatus>;
  getSetupStatus?: () => Promise<DesktopSetupStatus>;
  saveSetupStatus?: (status: DesktopSetupStatus) => Promise<DesktopSetupStatus>;
  chooseWorkspaceDirectory?: () => Promise<DesktopWorkspaceCandidate | null>;
  validateWorkspacePath?: (workspacePath: string) => Promise<DesktopPathValidationResult>;
  discoverAgentPresets?: (presets: DesktopAgentPresetInput[]) => Promise<DesktopAgentPresetDiscovery[]>;
  installAgentPreset?: (presetId: string) => Promise<{ ok: boolean; message: string }>;
  revealPath?: (workspacePath: string) => Promise<boolean>;
  checkRuntime?: (runtime: string) => Promise<DesktopRuntimeCheckResult>;
  checkForUpdates: () => Promise<DesktopUpdateStatus | void>;
  getUpdateStatus?: () => Promise<DesktopUpdateStatus>;
  installUpdate?: () => Promise<DesktopUpdateStatus>;
  showUpdateNotification?: (payload?: DesktopNotification) => Promise<boolean>;
  onUpdateStatus?: (listener: (status: DesktopUpdateStatus) => void) => () => void;
  /** Whether this window is in macOS native full screen, where the traffic lights are hidden. */
  getFullScreen?: () => Promise<boolean>;
  onFullScreenChange?: (listener: (fullScreen: boolean) => void) => () => void;
  onDaemonStatus?: (listener: (status: DesktopDaemonStatus) => void) => () => void;
  onNotificationReply?: (listener: (reply: DesktopNotificationReply) => void) => () => void;
  /** iOS native shell controls the bottom tab dock instead of the web-rendered one. */
  setMobileTabState?: (state: {
    visible: boolean; activeView: string; spaceId?: string | null; userId?: string | null;
    /** An Agent in the Space is working now: the Status pulse runs. */
    statusLive?: boolean;
  }) => Promise<void>;
  /** A tab the user picked; `spaceId` when that tab must follow the Space the user is in. */
  onMobileTabChange?: (listener: (event: { view: string; spaceId?: string }) => void) => () => void;
  /** Android asks the Web shell to consume system Back before WebView history or Activity exit. */
  onBackRequested?: (listener: () => boolean) => () => void;
};

declare global {
  interface Window {
    xmatrixDesktop?: DesktopBridge;
  }
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.xmatrixDesktop || null;
}
