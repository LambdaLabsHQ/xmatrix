import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { installAgentPreset } from "./agent-preset-install";
import os from "node:os";
import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type MenuItemConstructorOptions,
  shell,
} from "electron";
import { autoUpdater } from "electron-updater";
import {
  commandLooksLikeXmatrixDaemon,
  parseDaemonLockPid,
  parsePsDaemonProcesses,
  type ExistingDaemonProcess,
} from "./daemon-owner";
import {
  augmentPath as augmentCliPath,
  resolveCliExecutable as resolveCliExecutablePath,
} from "./cli-executable";
import {
  desktopCliSeedPath,
  installCliFromSeed,
  type DesktopCliInstallResult,
} from "./cli-seed-install";
import {
  daemonProcessChangeTracker,
  defaultCliRunner,
  importCliSession,
  readCliContext,
  resolveSessionCli,
  type DesktopCliContext,
  type DesktopCliProfile,
} from "./cli-context";
import {
  writePrivateJsonAtomic,
  type DesktopCliSessionPayload,
  type DesktopCliSessionSaveResult,
} from "./cli-session";
import type {
  DesktopAgentPresetDiscovery,
  DesktopAgentPresetInput,
  DesktopDaemonState,
  DesktopDaemonStatus,
  DesktopSetupStatus,
  DesktopUpdateState,
  DesktopUpdateStatus,
  DesktopWorkspaceCandidate,
} from "./desktop-ipc-types";
import {
  dockBadgeText,
  planNotification,
  type DesktopBadgeState,
  type DesktopNotificationPayload,
} from "./notifications";
import { readableUpdateErrorMessage, shouldShowUpdateRecovery } from "./update-errors";
import { daemonFailureNeedsLogin } from "./daemon-failure";
import { DEFAULT_SHELL_BACKGROUND_COLOR, desktopTitleBarOptions } from "./window-chrome";
import { planWindowOpen } from "./window-navigation";
import {
  aggregateBadge,
  appSpaceKey,
  cascadeBounds,
  findWindowForTarget,
  pickPrimaryWindowId,
  resolveInternalAppUrl,
} from "./window-registry";

const APP_PROTOCOL = "xmatrix";
const DEFAULT_WEB_URL = "https://xmatrix.sh/app";
const CLI_INSTALL_URL = "https://xmatrix.sh/docs";
const MANUAL_DOWNLOAD_URL = "https://xmatrix.sh/download";
const UPDATE_CHECK_DELAY_MS = 15_000;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DAEMON_HEARTBEAT_INTERVAL_MS = 30_000;
const DAEMON_RESTART_DELAY_MS = 2_000;
const DAEMON_PROCESS_SCAN_TIMEOUT_MS = 2_000;
const DAEMON_ONLINE_WAIT_ATTEMPTS = 8;
const DAEMON_ONLINE_WAIT_DELAY_MS = 500;
const DAEMON_OUTPUT_MAX_CHARS = 4_000;
const DAEMON_LOCK_FILE_NAME = "daemon.lock";
const DESKTOP_SETUP_VERSION = 1;
const MAC_DAEMON_LAUNCH_AGENT_LABEL = "sh.xmatrix.daemon";
const WINDOWS_DAEMON_TASK_NAME = "xmatrix-daemon";
/** The page lays its window frame out around these (apps/web globals.css,
 * "The window frame"): the lights are centred on the rail and on the 52px
 * band across the top. The page owns all frame CSS; the shell injects none. */
const MAC_TRAFFIC_LIGHT_POSITION = { x: 12, y: 19 };

type DesktopNotificationReply = {
  channelId: string;
  body: string;
  /**
   * The window that raised the notification. A reply belongs to the window that
   * was showing that Space, not to whichever window happens to be focused when
   * the user answers the banner.
   */
  targetWindowId?: number;
};

type DesktopPathValidationResult = {
  ok: boolean;
  path?: string;
  canonicalCwd?: string;
  displayName?: string;
  error?: string;
};

type DesktopRuntimeCheckResult = {
  ok: boolean;
  runtime: string;
  path?: string;
  version?: string;
  error?: string;
};

/**
 * Every open shell window, oldest first. The shell is multi-window so one user
 * can work in two Spaces at once; a Space is only a web route, so a second
 * Space is a second window in the same Electron session (shared cookies,
 * and IndexedDB — exactly like a second browser tab).
 */
const appWindows: BrowserWindow[] = [];
let lastFocusedWindowId: number | null = null;
/** Each window's own unread report; the dock carries one badge for all of them. */
const windowBadges = new Map<number, DesktopBadgeState>();
let pendingDeepLink: string | null = null;
const pendingNotificationReplies: DesktopNotificationReply[] = [];
let updateCheckTimer: NodeJS.Timeout | null = null;
let checkingForUpdates = false;
let manualUpdateCheck = false;
let updateDownloadStartedFromManualCheck = false;
let updateStatus: DesktopUpdateStatus = createUpdateStatus("idle");
let daemonStatus: DesktopDaemonStatus = createDaemonStatus("stopped");
let daemonProcess: ChildProcess | null = null;
let daemonHeartbeatTimer: NodeJS.Timeout | null = null;
let daemonHeartbeatInFlight = false;
let daemonRestartTimer: NodeJS.Timeout | null = null;
let daemonKeepAliveEnabled = false;
let daemonStartInFlight: Promise<DesktopDaemonStatus> | null = null;
let appIsQuitting = false;
type DesktopLocalProfileSelection =
  | { mode: "follow-default" }
  | { mode: "explicit"; profileId: string };
let desktopProfileSelection: DesktopLocalProfileSelection = { mode: "follow-default" };
let desktopProfileSelectionMutationTail: Promise<void> = Promise.resolve();
let profileRegistryWatcher: fs.FSWatcher | null = null;
let lastDefaultProfileRevision = 0;
// The CLI's answers to `session show`: for the window's selected profile (with
// the token the sync transport needs) and for the installation default.
let selectedCliContext: DesktopCliContext | null = null;
let defaultCliContext: DesktopCliContext | null = null;
let desktopProfileReady: Promise<void> = Promise.resolve();

// Dev-only: an isolated userData dir lets an unpackaged dev instance run
// (and take its own single-instance lock) while the installed app is open.
const devUserDataDir = process.env.XMATRIX_DESKTOP_USER_DATA_DIR;
if (devUserDataDir && !app.isPackaged) {
  app.setPath("userData", devUserDataDir);
}

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

app.setName("xMatrix");

function getStartUrl(): string {
  return normalizeAppUrl(
    process.env.XMATRIX_DESKTOP_DEV_URL ||
      process.env.XMATRIX_DESKTOP_WEB_URL ||
      DEFAULT_WEB_URL
  );
}

function getWebOrigin(): string {
  const url = new URL(getStartUrl());
  return url.origin;
}

function normalizeAppUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/app";
  }
  return url.toString();
}

function isTrustedAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === `${APP_PROTOCOL}:`) {
      return true;
    }

    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }

    return isTrustedWebOrigin(url) || isLocalDevOrigin(url);
  } catch {
    return false;
  }
}

function isTrustedWebOrigin(url: URL): boolean {
  return url.protocol === "https:" && (
    url.hostname === "xmatrix.sh" ||
    url.hostname === "www.xmatrix.sh" ||
    url.hostname === "test.xmatrix.sh"
  );
}

function isLocalDevOrigin(url: URL): boolean {
  if (app.isPackaged || !["http:", "https:"].includes(url.protocol)) {
    return false;
  }

  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

function trustedSenderOrigin(event: IpcMainInvokeEvent): string | null {
  const frameUrl = event.senderFrame?.url || event.sender.getURL();
  try {
    const url = new URL(frameUrl);
    return isTrustedWebOrigin(url) || isLocalDevOrigin(url) ? url.origin : null;
  } catch {
    return null;
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return trustedSenderOrigin(event) !== null;
}

function openExternalUrl(value: string): void {
  const plan = planWindowOpen(value);
  if (plan.kind === "external") {
    void shell.openExternal(plan.url);
  }
}

function secureIpc<T extends unknown[], R>(
  handler: (event: IpcMainInvokeEvent, ...args: T) => R
) {
  return async (event: IpcMainInvokeEvent, ...args: T) => {
    if (!isTrustedSender(event)) {
      throw new Error("Untrusted xMatrix desktop bridge caller");
    }
    // Page assets may load during CLI startup, but the bridge must never
    // observe a provisional profile or mutate the wrong account.
    await desktopProfileReady;
    if (!isTrustedSender(event)) {
      throw new Error("Untrusted xMatrix desktop bridge caller");
    }
    return handler(event, ...args);
  };
}

function applyDesktopNativeTheme(): void {
  if (process.platform !== "win32") return;
  nativeTheme.themeSource = "light";
}

function liveWindows(): BrowserWindow[] {
  return appWindows.filter((window) => !window.isDestroyed());
}

/**
 * The window a window-less action belongs to: a menu command, a deep link, a
 * dialog with no obvious parent. Follows the focused window so the user's
 * attention decides, and falls back to the last one they touched.
 */
function primaryWindow(): BrowserWindow | null {
  const id = pickPrimaryWindowId(
    appWindows.map((window) => ({
      id: window.id,
      destroyed: window.isDestroyed(),
      focused: !window.isDestroyed() && window.isFocused(),
    })),
    lastFocusedWindowId
  );
  return id === null ? null : appWindows.find((window) => window.id === id) ?? null;
}

function canReceive(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed());
}

/** Shell state (update, daemon, profile) is process-wide: every window hears it. */
function broadcastToWindows(channel: string, payload: unknown): void {
  for (const window of liveWindows()) {
    if (canReceive(window)) window.webContents.send(channel, payload);
  }
}

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function newWindowPosition(openedFrom: BrowserWindow | null) {
  const size = { width: 1280, height: 860 };
  const anchor = openedFrom && !openedFrom.isDestroyed() ? openedFrom.getBounds() : null;
  const display = anchor
    ? screen.getDisplayMatching(anchor)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return cascadeBounds(anchor, display.workArea, size);
}

function createWindow(targetUrl?: string): BrowserWindow {
  applyDesktopNativeTheme();
  const openedFrom = primaryWindow();
  const { x, y } = newWindowPosition(openedFrom);
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    x,
    y,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: "xMatrix",
    ...desktopTitleBarOptions(process.platform, MAC_TRAFFIC_LIGHT_POSITION),
    backgroundColor: DEFAULT_SHELL_BACKGROUND_COLOR,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  appWindows.push(window);

  window.loadURL(targetUrl || getStartUrl());

  window.webContents.on("did-finish-load", () => {
    sendUpdateStatus();
    sendDaemonStatus();
    void desktopProfileReady.then(() => {
      if (!appIsQuitting) return publishDefaultProfileChanged(true);
    });
    flushPendingNotificationReplies();
    scheduleEvidenceShots(window);
  });

  window.once("ready-to-show", () => {
    window.show();
    if (pendingDeepLink) {
      openDeepLink(pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  window.on("focus", () => {
    lastFocusedWindowId = window.id;
  });

  // Native full screen hides the traffic lights; the page drops their band.
  window.on("enter-full-screen", () => {
    window.webContents.send("desktop:full-screen-changed", true);
  });
  window.on("leave-full-screen", () => {
    window.webContents.send("desktop:full-screen-changed", false);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedAppUrl(url)) {
      return;
    }

    event.preventDefault();
    openExternalUrl(url);
  });

  window.on("closed", () => {
    const index = appWindows.indexOf(window);
    if (index >= 0) appWindows.splice(index, 1);
    if (lastFocusedWindowId === window.id) lastFocusedWindowId = null;
    // A closed window's unreads are no longer on screen anywhere; drop them
    // from the badge rather than leaving a count nothing can clear.
    windowBadges.delete(window.id);
    refreshDockBadge();
  });

  return window;
}

/**
 * Open `targetUrl` in a window of its own, unless a window already holds that
 * Space — then raise that one instead of creating a duplicate view of it.
 *
 * `navigateExisting` says whether the reused window should also be sent to the
 * exact URL. A deep link or notification names a destination and must land on
 * it; "open this Space in a new window" only names a Space, so navigating
 * would yank an already-open window off the channel the user is reading.
 */
function openWindowForUrl(
  targetUrl: string,
  { navigateExisting }: { navigateExisting: boolean }
): BrowserWindow {
  const existingId = findWindowForTarget(
    appWindows.map((window) => ({
      id: window.id,
      destroyed: window.isDestroyed(),
      focused: !window.isDestroyed() && window.isFocused(),
      url: window.isDestroyed() ? "" : window.webContents.getURL(),
    })),
    targetUrl
  );
  const existing = existingId === null
    ? null
    : appWindows.find((window) => window.id === existingId) ?? null;
  if (existing && !existing.isDestroyed()) {
    if (navigateExisting && existing.webContents.getURL() !== targetUrl) {
      existing.loadURL(targetUrl);
    }
    revealWindow(existing);
    return existing;
  }
  return createWindow(targetUrl);
}

/**
 * Dev-only capture hook for automated desktop UI verification: when
 * XMATRIX_DESKTOP_SHOT_PATH is set (and the app is unpackaged), write a
 * capture of the main window page there a few seconds after load.
 */
function scheduleEvidenceShots(window: BrowserWindow) {
  const shotPath = process.env.XMATRIX_DESKTOP_SHOT_PATH;
  if (!shotPath || app.isPackaged) return;
  const delayMs = Number(process.env.XMATRIX_DESKTOP_SHOT_DELAY_MS || "6000");
  setTimeout(() => {
    void (async () => {
      try {
        if (window.isDestroyed()) return;
        const page = await window.webContents.capturePage();
        fs.writeFileSync(shotPath, page.toPNG());
        console.log(`xMatrix evidence shots written to ${shotPath}`);
      } catch (error) {
        console.warn("xMatrix evidence shot failed", error);
      }
    })();
  }, delayMs);
}

function buildMenu() {
  const updateMenuItem = desktopUpdateMenuItem(updateStatus);
  const template: MenuItemConstructorOptions[] = [
    {
      label: "xMatrix",
      submenu: [
        { role: "about" },
        ...updateMenuItem,
        { type: "separator" },
        {
          label: "New Window",
          accelerator: "CommandOrControl+N",
          click: () => {
            // A bare /app window lands in the working Space; switching Space in
            // it is what gives the user two Spaces side by side.
            createWindow();
          },
        },
        {
          // macOS keeps Close in the app/File menu, not in the Window menu the
          // windowMenu role builds; without it a second window can only be
          // closed from the traffic light.
          label: "Close Window",
          accelerator: "CommandOrControl+W",
          role: "close",
        },
        { type: "separator" },
        {
          label: "Open xMatrix",
          accelerator: "CommandOrControl+1",
          click: () => openAppPath("/app"),
        },
        {
          label: "Open Overview",
          accelerator: "CommandOrControl+2",
          click: () => openAppPath("/app?view=overview"),
        },
        {
          label: "Open Docs",
          accelerator: "CommandOrControl+3",
          click: () => openAppPath("/docs"),
        },
        { type: "separator" },
        {
          label: "Check xMatrix CLI",
          click: async () => {
            const result = await checkCliInstalled();
            const options = {
              type: result.installed ? "info" : "warning",
              message: result.installed ? "xMatrix CLI is installed" : "xMatrix CLI was not found",
              detail: result.installed
                ? [result.version, result.path ? `Location: ${result.path}` : ""]
                    .filter(Boolean)
                    .join("\n") || "The xmatrix command is available."
                : "Install it from the docs, then reopen xMatrix.",
              buttons: result.installed ? ["OK"] : ["Open Docs", "OK"],
            } as const;
            const message = showMessageBox(options);
            message.then((response) => {
              if (!result.installed && response.response === 0) {
                openExternalUrl(CLI_INSTALL_URL);
              }
            });
          },
        },
        {
          label: "Start Daemon",
          click: () => {
            void startDaemonBestEffort();
          },
        },
        {
          label: "Stop Daemon",
          click: () => {
            void stopDaemon();
          },
        },
        {
          label: "Restart Daemon",
          click: () => {
            void restartDaemon();
          },
        },
        {
          label: "Daemon Status...",
          click: async () => {
            const status = getDaemonStatus();
            const options: MessageBoxOptions = {
              type: status.state === "running" ? "info" : "warning",
              message: `xMatrix daemon: ${status.state}`,
              detail: [status.pid ? `PID: ${status.pid}` : "", status.message || ""]
                .filter(Boolean)
                .join("\n"),
              buttons: ["OK"],
            };
            await showMessageBox(options);
          },
        },
        {
          type: "separator",
        },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      // macOS keeps the live list of open windows in whichever menu carries the
      // windowMenu role; with more than one window that list is how the user
      // moves between Spaces, so let the platform own this menu.
      ...(process.platform === "darwin"
        ? { role: "windowMenu" as const }
        : {
            submenu: [
              { role: "minimize" as const },
              { role: "zoom" as const },
              { role: "close" as const },
            ],
          }),
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function desktopUpdateMenuItem(status: DesktopUpdateStatus): MenuItemConstructorOptions[] {
  const targetVersion = formatAppVersion(status.version);

  if (status.state === "downloaded") {
    return [
      {
        label: targetVersion ? `Install ${targetVersion}...` : "Install Update...",
        click: () => {
          void installDownloadedUpdate();
        },
      },
    ];
  }

  if (status.state === "downloading") {
    const progress = status.percent === undefined ? "" : ` ${Math.round(status.percent)}%`;
    return [
      {
        label: targetVersion
          ? `Downloading ${targetVersion}${progress}`
          : `Downloading Update${progress}`,
        enabled: false,
      },
    ];
  }

  if (status.state === "available") {
    return [
      {
        label: targetVersion ? `Update to ${targetVersion}...` : "Update xMatrix...",
        click: () => {
          void installDownloadedUpdate();
        },
      },
    ];
  }

  if (status.state === "checking") {
    return [
      {
        label: "Checking for Updates...",
        enabled: false,
      },
    ];
  }

  if (status.state === "installing") {
    return [
      {
        label: targetVersion ? `Installing ${targetVersion}...` : "Installing Update...",
        enabled: false,
      },
    ];
  }

  if (status.state === "error") {
    return [
      {
        label: "Check for Updates...",
        click: () => void checkForUpdates(true),
      },
      {
        label: "Download Update Manually...",
        click: () => openExternalUrl(MANUAL_DOWNLOAD_URL),
      },
    ];
  }

  return [
    {
      label: "Check for Updates...",
      click: () => void checkForUpdates(true),
    },
  ];
}

function refreshApplicationMenu() {
  if (!app.isReady()) return;
  buildMenu();
}

function formatAppVersion(version: string | undefined) {
  const value = version?.trim();
  if (!value) return "";
  return /^v/i.test(value) ? value : `v${value}`;
}

function openAppPath(pathname: string, inWindow?: BrowserWindow | null) {
  const url = new URL(pathname, getWebOrigin());
  const window = inWindow && !inWindow.isDestroyed() ? inWindow : primaryWindow();
  if (window) {
    window.loadURL(url.toString());
    revealWindow(window);
  } else {
    pendingDeepLink = url.toString();
    createWindow();
  }
}

function openDeepLink(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== `${APP_PROTOCOL}:`) {
      return;
    }

    if (url.hostname === "channel") {
      const channelId = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (channelId) {
        openAppPath(`/app?channel=${encodeURIComponent(channelId)}`);
        return;
      }
    }

    if (url.hostname === "login") {
      openAppPath(`/login${url.search}`);
      return;
    }

    openAppPath("/app");
  } catch {
    openAppPath("/app");
  }
}

function setDockBadge(state: DesktopBadgeState) {
  if (process.platform !== "darwin" || !app.dock) {
    return;
  }
  app.dock.setBadge(dockBadgeText(state));
}

/**
 * Recompute the single dock badge from what every open window last reported.
 * A window reports the Space it is showing, so two Spaces add up and two
 * windows on one Space do not.
 */
function refreshDockBadge() {
  const reports = liveWindows().flatMap((window) => {
    const state = windowBadges.get(window.id);
    if (!state) return [];
    const url = window.webContents.isDestroyed() ? "" : window.webContents.getURL();
    return [{
      key: appSpaceKey(url) ?? `window:${window.id}`,
      mentionCount: state.mentionCount ?? 0,
      hasUnread: Boolean(state.hasUnread),
    }];
  });
  setDockBadge(aggregateBadge(reports));
}

function showMessageBox(options: MessageBoxOptions) {
  const parent = primaryWindow();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

function revealWindow(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function focusMainWindow() {
  const window = primaryWindow();
  if (!window) {
    createWindow();
    return;
  }

  revealWindow(window);
}

function openNotificationTarget(
  payload: DesktopNotificationPayload,
  originWindowId?: number
) {
  const originWindow = originWindowId === undefined
    ? null
    : appWindows.find((window) => window.id === originWindowId) ?? null;
  const rawUrl = typeof payload.url === "string" ? payload.url.trim() : "";
  if (rawUrl) {
    try {
      const target = new URL(rawUrl, getWebOrigin()).toString();
      if (isTrustedAppUrl(target)) {
        // Land in the window that already holds this Space rather than
        // navigating whichever window is focused away from its own Space.
        openWindowForUrl(target, { navigateExisting: true });
        return;
      }
    } catch {
      // Fall through to channel/app focus.
    }
  }

  const channelId = typeof payload.channelId === "string" ? payload.channelId.trim() : "";
  if (channelId) {
    openAppPath(`/app?channel=${encodeURIComponent(channelId)}`, originWindow);
    return;
  }

  if (originWindow && !originWindow.isDestroyed()) {
    revealWindow(originWindow);
    return;
  }
  focusMainWindow();
}

function getNotificationSettings() {
  const supported = Notification.isSupported();
  return {
    supported,
    permission: supported ? "granted" : "unsupported",
    alert: supported,
    badge: process.platform === "darwin",
    sound: supported,
  };
}

function updateChecksEnabled() {
  return (
    app.isPackaged &&
    platformSupportsUpdateChecks() &&
    process.env.XMATRIX_DESKTOP_DISABLE_UPDATES !== "1"
  );
}

function platformSupportsUpdateChecks() {
  return process.platform === "darwin" || process.platform === "win32";
}

function automaticUpdateUnavailableMessage() {
  if (!app.isPackaged) {
    return "Build and install the packaged xMatrix app to use automatic updates.";
  }

  if (!platformSupportsUpdateChecks()) {
    return "Automatic updates are not available on this platform.";
  }

  return "Automatic updates are disabled for this build.";
}

function createUpdateStatus(
  state: DesktopUpdateState,
  status: Partial<Omit<DesktopUpdateStatus, "state" | "enabled" | "currentVersion" | "updatedAt">> = {}
): DesktopUpdateStatus {
  return {
    state,
    enabled: updateChecksEnabled(),
    currentVersion: app.getVersion(),
    ...status,
    updatedAt: new Date().toISOString(),
  };
}

function getUpdateStatus() {
  return {
    ...updateStatus,
    enabled: updateChecksEnabled(),
    currentVersion: app.getVersion(),
  };
}

function setUpdateStatus(
  state: DesktopUpdateState,
  status: Partial<Omit<DesktopUpdateStatus, "state" | "enabled" | "currentVersion" | "updatedAt">> = {}
) {
  updateStatus = createUpdateStatus(state, status);
  refreshApplicationMenu();
  sendUpdateStatus();
  return getUpdateStatus();
}

async function showUpdateErrorDialog(message: string) {
  const response = await showMessageBox({
    type: "warning",
    message: "Could not update xMatrix",
    detail: message,
    buttons: ["Download Manually...", "OK"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response.response === 0) {
    openExternalUrl(MANUAL_DOWNLOAD_URL);
  }
}

function sendUpdateStatus() {
  broadcastToWindows("desktop:update-status", getUpdateStatus());
}

function createDaemonStatus(
  state: DesktopDaemonState,
  status: Partial<Omit<DesktopDaemonStatus, "state" | "updatedAt">> = {}
): DesktopDaemonStatus {
  return {
    state,
    ...status,
    updatedAt: new Date().toISOString(),
  };
}

function getDaemonStatus() {
  if (isDaemonProcessAlive(daemonProcess)) {
    return createDaemonStatus("running", {
      pid: daemonProcess.pid,
      message: "xMatrix daemon is running.",
    });
  }

  return daemonStatus;
}

function setDaemonStatus(
  state: DesktopDaemonState,
  status: Partial<Omit<DesktopDaemonStatus, "state" | "updatedAt">> = {}
) {
  daemonStatus = createDaemonStatus(state, status);
  sendDaemonStatus();
  return getDaemonStatus();
}

function sendDaemonStatus() {
  broadcastToWindows("desktop:daemon-status", getDaemonStatus());
}

function isDaemonProcessAlive(child: ChildProcess | null): child is ChildProcess {
  if (!child || child.killed || typeof child.pid !== "number") {
    return false;
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return false;
  }

  try {
    process.kill(child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function rememberDaemonOutput(current: string, chunk: Buffer | string) {
  const next = `${current}${chunk.toString()}`;
  return next.length > DAEMON_OUTPUT_MAX_CHARS ? next.slice(-DAEMON_OUTPUT_MAX_CHARS) : next;
}

function daemonOutputSummary(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" ");
}


function daemonLoginRequiredMessage(output: string) {
  const summary = daemonOutputSummary(output);
  return [
    "xMatrix daemon needs a fresh CLI session. Sign in from the desktop app or run xmatrix login.",
    summary,
  ].filter(Boolean).join(" ");
}

function daemonExitMessage(message: string, output: string) {
  const summary = daemonOutputSummary(output);
  return summary ? `${message} ${summary}` : message;
}

function clearDaemonRestartTimer() {
  if (!daemonRestartTimer) {
    return;
  }

  clearTimeout(daemonRestartTimer);
  daemonRestartTimer = null;
}

const daemonProcessChanged = daemonProcessChangeTracker();

/** After the CLI context is read again, windows hear the daemon is running and
 * read the desktop context that now carries the Machine id. */
function rereadCliContextForNewDaemon(pid?: number) {
  if (daemonProcessChanged(pid)) void refreshCliContext().then(sendDaemonStatus, () => undefined);
}

function runningLocalDaemonStatus(pid?: number, managed = false) {
  // The daemon owns its Hub socket, backoff, and fresh-socket catch-up. Desktop
  // supervises only local process liveness so a temporary Hub outage cannot
  // make macOS LaunchAgent restart the daemon and reset that reconnect state.
  rereadCliContextForNewDaemon(pid);
  return setDaemonStatus("running", {
    pid,
    message: managed && pid
      ? `xMatrix daemon is managed by the local service (pid ${pid}); Hub reconnection is managed by the daemon.`
      : "xMatrix daemon process is running locally; Hub reconnection is managed by the daemon.",
  });
}

function enableDaemonKeepAlive() {
  daemonKeepAliveEnabled = true;
  startDaemonHeartbeat();
}

function disableDaemonKeepAlive() {
  daemonKeepAliveEnabled = false;
  clearDaemonRestartTimer();
  stopDaemonHeartbeat();
}

function scheduleDaemonRestart(message: string) {
  if (appIsQuitting || !daemonKeepAliveEnabled || daemonRestartTimer) {
    return;
  }

  setDaemonStatus("starting", { message });
  daemonRestartTimer = setTimeout(() => {
    daemonRestartTimer = null;
    void restartDaemonIfUnavailable(message);
  }, DAEMON_RESTART_DELAY_MS);
}

async function restartDaemonIfUnavailable(message: string) {
  if (appIsQuitting || !daemonKeepAliveEnabled) {
    return getDaemonStatus();
  }

  if (isDaemonProcessAlive(daemonProcess)) {
    return getDaemonStatus();
  }

  if (daemonProcess) {
    daemonProcess = null;
  }

  const existing = await findExistingDaemonProcess();
  if (existing) {
    return runningLocalDaemonStatus(existing.pid, true);
  }

  setDaemonStatus("starting", { message });
  return startDaemonBestEffort();
}

function startDaemonHeartbeat() {
  if (daemonHeartbeatTimer) {
    return;
  }

  daemonHeartbeatTimer = setInterval(() => {
    void runDaemonHeartbeat();
  }, DAEMON_HEARTBEAT_INTERVAL_MS);
}

function stopDaemonHeartbeat() {
  if (!daemonHeartbeatTimer) {
    return;
  }

  clearInterval(daemonHeartbeatTimer);
  daemonHeartbeatTimer = null;
}

async function runDaemonHeartbeat() {
  if (daemonHeartbeatInFlight || appIsQuitting || !daemonKeepAliveEnabled) {
    return;
  }

  daemonHeartbeatInFlight = true;
  try {
    if (isDaemonProcessAlive(daemonProcess)) {
      runningLocalDaemonStatus(daemonProcess.pid);
      return;
    }

    if (daemonProcess) {
      daemonProcess = null;
    }
    const existing = await findExistingDaemonProcess();
    if (existing) {
      runningLocalDaemonStatus(existing.pid, true);
      return;
    }
    scheduleDaemonRestart("xMatrix daemon process is not alive; restarting daemon...");
  } finally {
    daemonHeartbeatInFlight = false;
  }
}

/**
 * Where an inline notification reply is delivered: the window that raised the
 * notification, because that is the window signed into the Space the channel
 * lives in. If that window is gone, fall back to the primary one — dropping the
 * reply the user already typed would be worse than sending it from elsewhere.
 */
function notificationReplyTarget(targetWindowId?: number): BrowserWindow | null {
  const origin = targetWindowId === undefined
    ? null
    : appWindows.find((window) => window.id === targetWindowId) ?? null;
  if (canReceive(origin)) return origin;
  const fallback = primaryWindow();
  return canReceive(fallback) ? fallback : null;
}

function sendNotificationReply(channelId: string, body: string, targetWindowId?: number) {
  const trimmed = body.trim();
  if (!channelId || !trimmed) {
    return;
  }
  const target = notificationReplyTarget(targetWindowId);
  if (!target) {
    pendingNotificationReplies.push({ channelId, body: trimmed, targetWindowId });
    createWindow();
    return;
  }
  target.webContents.send("desktop:notification-reply", { channelId, body: trimmed });
}

function flushPendingNotificationReplies() {
  if (pendingNotificationReplies.length === 0) return;
  const deliverable = pendingNotificationReplies.filter((reply) =>
    Boolean(notificationReplyTarget(reply.targetWindowId))
  );
  if (deliverable.length === 0) return;
  for (const reply of deliverable) {
    const index = pendingNotificationReplies.indexOf(reply);
    if (index >= 0) pendingNotificationReplies.splice(index, 1);
    notificationReplyTarget(reply.targetWindowId)?.webContents.send(
      "desktop:notification-reply",
      { channelId: reply.channelId, body: reply.body }
    );
  }
}

function showNativeNotification(
  payload: DesktopNotificationPayload,
  originWindowId?: number
) {
  const plan = planNotification(payload);
  if (!Notification.isSupported() || !plan.show) {
    return false;
  }

  const notification = new Notification(plan.options);
  notification.on("click", () => {
    openNotificationTarget(payload, originWindowId);
  });
  if (plan.canReply) {
    notification.on("reply", (_event, reply) => {
      sendNotificationReply(
        plan.channelId,
        typeof reply === "string" ? reply : "",
        originWindowId
      );
    });
  }
  notification.show();
  // Standard macOS chat-app behavior (WeChat / Lark / Slack): the native banner
  // plus the dock badge are the notification. Do NOT bounce the dock — the dock
  // bounce ("come deal with this now") is reserved for explicit attention requests
  // and reads as intrusive for routine messages.
  return true;
}

function getUpdateNotificationCopy(status = getUpdateStatus()) {
  switch (status.state) {
    case "checking":
      return {
        title: "Checking for xMatrix updates",
        body: `Current version ${status.currentVersion}.`,
      };
    case "available":
      return {
        title: "xMatrix update is available",
        body: status.version
          ? `Version ${status.version} is ready to download.`
          : "A new version is ready to download.",
      };
    case "downloading":
      return {
        title: "xMatrix update downloading",
        body: status.version
          ? `Version ${status.version} is downloading in the background.`
          : "A new version is downloading in the background.",
      };
    case "downloaded":
      return {
        title: "xMatrix update is ready",
        body: status.version
          ? `Version ${status.version} is ready. Quit and reopen xMatrix to install it.`
          : "Quit and reopen xMatrix to install the update.",
      };
    case "not-available":
      return {
        title: "xMatrix is up to date",
        body: `You are running version ${status.currentVersion}.`,
      };
    case "error":
      return {
        title: "Could not check for updates",
        body: status.message,
      };
    case "disabled":
      return {
        title: "xMatrix automatic updates are unavailable",
        body: status.message || "Updates run in the packaged xMatrix app.",
      };
    default:
      return {
        title: "xMatrix automatic updates",
        body: updateChecksEnabled()
          ? `Current version ${status.currentVersion}. xMatrix checks automatically in the background.`
          : "Updates run in the packaged xMatrix app.",
      };
  }
}

function showUpdateNotification(payload?: DesktopNotificationPayload) {
  const copy = getUpdateNotificationCopy();
  return showNativeNotification({
    title: payload?.title || copy.title,
    body: payload?.body || copy.body,
    url: payload?.url,
    silent: payload?.silent,
  });
}

function configureAutoUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    checkingForUpdates = true;
    setUpdateStatus("checking", { message: "Checking for updates." });
  });

  autoUpdater.on("update-available", (info) => {
    checkingForUpdates = false;
    updateDownloadStartedFromManualCheck = manualUpdateCheck;
    setUpdateStatus("downloading", {
      version: info.version,
      message: "A new version is downloading in the background.",
    });
    if (manualUpdateCheck) {
      void showMessageBox({
        type: "info",
        message: "xMatrix update found",
        detail: `Version ${info.version} is downloading in the background.`,
        buttons: ["OK"],
      });
    }
    manualUpdateCheck = false;
  });

  autoUpdater.on("update-not-available", () => {
    checkingForUpdates = false;
    updateDownloadStartedFromManualCheck = false;
    setUpdateStatus("not-available", {
      message: `You are running version ${app.getVersion()}.`,
    });
    if (manualUpdateCheck) {
      void showMessageBox({
        type: "info",
        message: "xMatrix is up to date",
        detail: `You are running version ${app.getVersion()}.`,
        buttons: ["OK"],
      });
    }
    manualUpdateCheck = false;
  });

  autoUpdater.on("download-progress", (progress) => {
    setUpdateStatus("downloading", {
      version: updateStatus.version,
      percent: progress.percent,
      message: `Downloading update (${Math.round(progress.percent)}%).`,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    checkingForUpdates = false;
    const shouldNotify = updateDownloadStartedFromManualCheck;
    setUpdateStatus("downloaded", {
      version: info.version,
      percent: 100,
      message: "The downloaded update will install automatically when xMatrix restarts.",
    });
    if (shouldNotify) {
      showUpdateNotification();
      void showMessageBox({
        type: "info",
        message: "xMatrix update is ready",
        detail: `Version ${info.version} has been downloaded. Restart xMatrix to install it now.`,
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      }).then((response) => {
        if (response.response === 0) {
          installDownloadedUpdate();
        }
      });
    }
  });

  autoUpdater.on("error", (error) => {
    const shouldShowRecovery = shouldShowUpdateRecovery({
      manualUpdateCheck,
      manualDownloadInProgress: updateDownloadStartedFromManualCheck,
      state: updateStatus.state,
    });
    checkingForUpdates = false;
    updateDownloadStartedFromManualCheck = false;
    console.warn("xMatrix update check failed", error);
    const message = readableUpdateErrorMessage(error);
    setUpdateStatus("error", { message });
    if (shouldShowRecovery) {
      void showUpdateErrorDialog(message);
    }
    manualUpdateCheck = false;
  });

  if (!updateChecksEnabled()) {
    setUpdateStatus("disabled", {
      message: automaticUpdateUnavailableMessage(),
    });
    return;
  }

  setUpdateStatus("idle", {
    message: "xMatrix checks for updates automatically in the background.",
  });
  setTimeout(() => void checkForUpdates(), UPDATE_CHECK_DELAY_MS);
  updateCheckTimer = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
}

async function checkForUpdates(manual = false) {
  if (!updateChecksEnabled()) {
    const status = setUpdateStatus("disabled", {
      message: automaticUpdateUnavailableMessage(),
    });
    if (manual) {
      await showMessageBox({
        type: "info",
        message: "Updates are checked in the packaged xMatrix app",
        detail: automaticUpdateUnavailableMessage(),
        buttons: ["OK"],
      });
    }
    return status;
  }

  if (updateStatus.state === "downloaded") {
    if (manual) {
      await showMessageBox({
        type: "info",
        message: "xMatrix update is ready",
        detail: updateStatus.version
          ? `Version ${updateStatus.version} has been downloaded. Quit and reopen xMatrix to install it.`
          : "Quit and reopen xMatrix to install the downloaded update.",
        buttons: ["OK"],
      });
    }
    return getUpdateStatus();
  }

  if (updateStatus.state === "downloading") {
    if (manual) {
      await showMessageBox({
        type: "info",
        message: "xMatrix update is downloading",
        detail: updateStatus.percent
          ? `Download is ${Math.round(updateStatus.percent)}% complete.`
          : "The update is downloading in the background.",
        buttons: ["OK"],
      });
    }
    return getUpdateStatus();
  }

  if (updateStatus.state === "available") {
    if (manual) {
      await showMessageBox({
        type: "info",
        message: "xMatrix update is available",
        detail: updateStatus.version
          ? `Version ${updateStatus.version} is available. Click Update to download it.`
          : "A new version is available. Click Update to download it.",
        buttons: ["OK"],
      });
    }
    return getUpdateStatus();
  }

  if (checkingForUpdates) {
    if (manual) {
      await showMessageBox({
        type: "info",
        message: "Already checking for updates",
        buttons: ["OK"],
      });
    }
    return getUpdateStatus();
  }

  checkingForUpdates = true;
  manualUpdateCheck = manualUpdateCheck || manual;
  setUpdateStatus("checking", { message: "Checking for updates." });

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    checkingForUpdates = false;
    manualUpdateCheck = false;
    console.warn("xMatrix update check failed", error);
    const message = readableUpdateErrorMessage(error);
    const status = setUpdateStatus("error", { message });
    if (manual) {
      await showMessageBox({
        type: "warning",
        message: "Could not check for updates",
        detail: message,
        buttons: ["OK"],
      });
    }
    return status;
  }

  return getUpdateStatus();
}

async function installDownloadedUpdate() {
  if (updateStatus.state === "available") {
    const version = updateStatus.version;
    setUpdateStatus("downloading", {
      version,
      message: "Downloading update.",
    });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      const message = readableUpdateErrorMessage(error);
      console.warn("xMatrix update download failed", error);
      return setUpdateStatus("error", { version, message });
    }
    return getUpdateStatus();
  }

  if (updateStatus.state !== "downloaded") {
    return getUpdateStatus();
  }

  const status = setUpdateStatus("installing", {
    version: updateStatus.version,
    percent: 100,
    message: "Restarting xMatrix to install the downloaded update.",
  });

  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      const message = readableUpdateErrorMessage(error);
      console.warn("xMatrix update install failed", error);
      setUpdateStatus("error", { message });
      updateDownloadStartedFromManualCheck = false;
      void showUpdateErrorDialog(message);
    }
  });

  return status;
}

function resolveCliExecutable() {
  return resolveCliExecutablePath({
    platform: process.platform,
    homeDir: app.getPath("home"),
    envPath: process.env.PATH,
    envCliPath: process.env.XMATRIX_CLI_PATH,
    desktopExecPath: process.execPath,
  });
}

function checkCliInstalled(): Promise<{ installed: boolean; version?: string; path?: string }> {
  return new Promise((resolve) => {
    const executable = resolveCliExecutable();
    if (!executable) {
      resolve({ installed: false });
      return;
    }

    execFile(executable, ["--version"], { timeout: 3000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ installed: false });
        return;
      }

      resolve({
        installed: true,
        path: executable,
        version: (stdout || stderr).trim(),
      });
    });
  });
}

/**
 * Installs the CLI from the seed the release packaged under Resources/cli.
 * The seed copies itself into the user's bin directory and registers the
 * daemon; the App then adopts that daemon like any other start.
 */
async function installCliFromDesktopSeed(): Promise<DesktopCliInstallResult> {
  const result = await installCliFromSeed({
    seedPath: desktopCliSeedPath({ resourcesPath: process.resourcesPath, platform: process.platform }),
    platform: process.platform,
    env: { ...process.env, PATH: augmentPath(process.env.PATH) },
  });
  if (result.ok) {
    await startDaemonBestEffort();
  }
  return result;
}

function switchClientEnvironment(environment: unknown): Promise<{ environment: "production" | "test" }> {
  if (environment !== "production" && environment !== "test") {
    return Promise.reject(new Error("Unknown xMatrix environment."));
  }
  const executable = resolveCliExecutable();
  if (!executable) {
    return Promise.reject(new Error("Install or update the xMatrix CLI before switching environments."));
  }
  return new Promise((resolve, reject) => {
    execFile(executable, ["environment", "use", environment], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      void publishDefaultProfileChanged();
      resolve({ environment });
    });
  });
}

function augmentPath(value?: string) {
  return augmentCliPath(value, {
    platform: process.platform,
    homeDir: app.getPath("home"),
  });
}

function daemonEnvironment() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: augmentPath(process.env.PATH),
    XMATRIX_APP_VERSION: app.getVersion(),
  };
  if (process.env.XMATRIX_HUB_URL || process.env.XMATRIX_DESKTOP_HUB_URL) {
    env.XMATRIX_HUB_URL = process.env.XMATRIX_HUB_URL || process.env.XMATRIX_DESKTOP_HUB_URL || "";
  }
  return env;
}

/** The selected profile's Machine; another profile's id never stands in for it. */
function cliMachineId(): string | undefined {
  return selectedCliContext?.machineId ?? undefined;
}

function unixNowSecs() {
  return Math.floor(Date.now() / 1000);
}

function normalizeRequiredString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSessionUrl(value: string, allowedProtocols: string[], label: string) {
  try {
    const url = new URL(value);
    if (!allowedProtocols.includes(url.protocol)) {
      throw new Error(`${label} must use ${allowedProtocols.join(" or ")}`);
    }
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    if (error instanceof Error && error.message.includes("must use")) {
      throw error;
    }
    throw new Error(`${label} is invalid`);
  }
}

function normalizeCliSessionPayload(value: unknown): DesktopCliSessionPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid CLI session payload");
  }

  const record = value as Record<string, unknown>;
  const token = normalizeRequiredString(record, "token");
  const refreshToken = normalizeRequiredString(record, "refreshToken");
  const hubUrl = normalizeSessionUrl(
    normalizeRequiredString(record, "hubUrl"),
    ["http:", "https:"],
    "Hub URL"
  );
  const relayUrl = normalizeSessionUrl(
    normalizeRequiredString(record, "relayUrl"),
    ["ws:", "wss:"],
    "Relay URL"
  );
  const userRecord = record.user && typeof record.user === "object"
    ? record.user as Record<string, unknown>
    : {};
  const user = {
    id: normalizeRequiredString(userRecord, "id"),
    email: normalizeRequiredString(userRecord, "email"),
    name: normalizeRequiredString(userRecord, "name") || undefined,
    avatarUrl: normalizeRequiredString(userRecord, "avatarUrl") || undefined,
  };

  if (!token || !refreshToken || !user.id || !user.email) {
    throw new Error("CLI session payload is incomplete");
  }

  return {
    token,
    refreshToken,
    user,
    hubUrl,
    relayUrl,
  };
}

function sessionCliExecutable(): string | null {
  return resolveSessionCli({
    installed: resolveCliExecutable(),
    seed: desktopCliSeedPath({ resourcesPath: process.resourcesPath, platform: process.platform }),
    exists: (candidate) => fs.existsSync(candidate),
    isAbsolute: (candidate) => path.isAbsolute(candidate),
  });
}

function cliRunEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: augmentPath(process.env.PATH) };
}

/** Re-asks the CLI for the selected and default profile contexts. */
async function refreshCliContext(): Promise<void> {
  const executable = sessionCliExecutable();
  if (!executable) {
    selectedCliContext = null;
    defaultCliContext = null;
    return;
  }
  const env = cliRunEnv();
  const [selected, fallback] = await Promise.all([
    readCliContext({
      executable,
      profileId: explicitDesktopProfileId(),
      withToken: true,
      env,
      run: defaultCliRunner,
    }),
    readCliContext({ executable, env, run: defaultCliRunner }),
  ]);
  selectedCliContext = selected;
  defaultCliContext = fallback;
}

// The CLI saves the session and hot-reloads it into the running daemon.
// Periodic refresh must never restart the daemon because that would
// invalidate the broker URL held by live agent wrappers.
async function importCliSessionPayload(
  value: unknown,
  requireDaemon: boolean,
): Promise<DesktopCliSessionSaveResult> {
  const payload = normalizeCliSessionPayload(value);
  const executable = sessionCliExecutable();
  if (!executable) {
    // No installed CLI and no seed (a dev build): the web session still
    // works; this machine simply has no CLI sign-in to keep.
    return { ok: false, updatedAt: String(unixNowSecs()) };
  }
  const outcome = await importCliSession({
    executable,
    profileId: explicitDesktopProfileId(),
    payload,
    env: cliRunEnv(),
    run: defaultCliRunner,
  });
  if (outcome.daemon === "unsupported") {
    throw new Error(
      requireDaemon
        ? "The running xMatrix daemon does not support live session reload yet."
        : "Update the xMatrix daemon once to enable live session reload.",
    );
  }
  if (requireDaemon && outcome.daemon === "machine-name-required") {
    throw new Error("Name this machine in setup before starting the daemon.");
  }
  if (requireDaemon && outcome.daemon === "unavailable") {
    throw new Error("The local xMatrix daemon auth broker is unavailable.");
  }
  await refreshCliContext();
  return { ok: true, machineId: cliMachineId(), updatedAt: outcome.updatedAt };
}

function saveCliSession(value: unknown): Promise<DesktopCliSessionSaveResult> {
  return importCliSessionPayload(value, false);
}

function refreshCliSession(value: unknown): Promise<DesktopCliSessionSaveResult> {
  return importCliSessionPayload(value, true);
}

function daemonLockPath() {
  return path.join(xmatrixConfigDir(), DAEMON_LOCK_FILE_NAME);
}

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readDaemonLockOwnerPid() {
  try {
    return parseDaemonLockPid(fs.readFileSync(daemonLockPath(), "utf8"));
  } catch {
    return null;
  }
}

function lookupProcessCommand(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: DAEMON_PROCESS_SCAN_TIMEOUT_MS },
      (error, stdout) => {
        resolve(error ? "" : stdout.trim());
      }
    );
  });
}

function findWindowsDaemonProcess(): Promise<ExistingDaemonProcess | null> {
  const pipeline = [
    "Get-CimInstance Win32_Process -Filter \"Name = 'xmatrix.exe'\"",
    `Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -match '(^|\\s)daemon(\\s|$)' }`,
    "Sort-Object ProcessId",
    "Select-Object -First 1 @{Name='pid';Expression={$_.ProcessId}}, @{Name='command';Expression={$_.CommandLine}}",
    "ConvertTo-Json -Compress",
  ].join(" | ");
  const script = `$ErrorActionPreference = 'SilentlyContinue'; ${pipeline}`;

  return new Promise((resolve) => {
    const child = execFile(
      "powershell",
      ["-NoProfile", "-Command", script],
      { timeout: DAEMON_PROCESS_SCAN_TIMEOUT_MS },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }

        try {
          const parsed = JSON.parse(stdout.trim()) as { pid?: unknown; command?: unknown };
          const pid = typeof parsed.pid === "number" ? parsed.pid : Number(parsed.pid);
          const command = typeof parsed.command === "string" ? parsed.command : "";
          if (!Number.isSafeInteger(pid) || pid <= 0 || !commandLooksLikeXmatrixDaemon(command)) {
            resolve(null);
            return;
          }
          resolve({ pid, command, source: "process-scan" });
        } catch {
          resolve(null);
        }
      }
    );
    child.unref();
  });
}

async function findExistingDaemonProcess(): Promise<ExistingDaemonProcess | null> {
  if (process.platform === "win32") {
    return findWindowsDaemonProcess();
  }

  const lockPid = readDaemonLockOwnerPid();
  if (lockPid && processIsAlive(lockPid)) {
    const command = await lookupProcessCommand(lockPid);
    if (!command || commandLooksLikeXmatrixDaemon(command)) {
      return {
        pid: lockPid,
        command,
        source: "lock",
      };
    }
  }

  return new Promise((resolve) => {
    const child = execFile(
      "ps",
      ["-axo", "pid=,command="],
      { timeout: DAEMON_PROCESS_SCAN_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }

        const daemon = parsePsDaemonProcesses(stdout, process.pid)[0];
        resolve(daemon || null);
      }
    );
    child.unref();
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExistingDaemonProcess() {
  for (let attempt = 0; attempt < DAEMON_ONLINE_WAIT_ATTEMPTS; attempt += 1) {
    const existing = await findExistingDaemonProcess();
    if (existing) return existing;
    await sleep(DAEMON_ONLINE_WAIT_DELAY_MS);
  }
  return null;
}

function powershellSingleQuoted(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function runWindowsDaemonTaskCommand(scriptBody: string): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);

  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", scriptBody],
      { timeout: 5_000 },
      (error) => resolve(!error)
    );
  });
}

function windowsDaemonTaskIsInstalled(): Promise<boolean> {
  return runWindowsDaemonTaskCommand(
    `$ErrorActionPreference='Stop'; Get-ScheduledTask -TaskName ${powershellSingleQuoted(WINDOWS_DAEMON_TASK_NAME)} | Out-Null`
  );
}

function startWindowsDaemonTaskIfInstalled(): Promise<boolean> {
  return runWindowsDaemonTaskCommand(
    [
      "$ErrorActionPreference='Stop'",
      `$taskName=${powershellSingleQuoted(WINDOWS_DAEMON_TASK_NAME)}`,
      "Get-ScheduledTask -TaskName $taskName | Out-Null",
      "Start-ScheduledTask -TaskName $taskName",
    ].join("; ")
  );
}

async function finishInstalledDaemonStartup(started: boolean, errorMessage: string, waitingMessage: string) {
  if (!started) return setDaemonStatus("error", { message: errorMessage });
  const existing = await waitForExistingDaemonProcess();
  if (existing) return runningLocalDaemonStatus(existing.pid, true);
  return setDaemonStatus("starting", { message: waitingMessage });
}

async function startWindowsDaemonTaskIfAvailable(options: { force?: boolean } = {}) {
  if (!(await windowsDaemonTaskIsInstalled())) {
    return null;
  }

  daemonProcess = null;
  setDaemonStatus("starting", {
    message: "Starting xMatrix daemon through the Windows scheduled task...",
  });

  if (options.force) {
    await runWindowsDaemonTaskCommand(
      `$ErrorActionPreference='SilentlyContinue'; Stop-ScheduledTask -TaskName ${powershellSingleQuoted(WINDOWS_DAEMON_TASK_NAME)}`
    );
  }

  const started = await startWindowsDaemonTaskIfInstalled();
  return finishInstalledDaemonStartup(started,
    "xMatrix daemon task is installed, but Windows could not start it.",
    "xMatrix daemon scheduled task is starting; waiting for the daemon lock owner...",
  );
}

function macDaemonLaunchAgentTarget() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    return null;
  }
  return `gui/${process.getuid()}/${MAC_DAEMON_LAUNCH_AGENT_LABEL}`;
}

function macDaemonLaunchAgentIsInstalled(): Promise<boolean> {
  const target = macDaemonLaunchAgentTarget();
  if (!target) return Promise.resolve(false);

  return new Promise((resolve) => {
    execFile("launchctl", ["print", target], { timeout: 5_000 }, (error) => {
      resolve(!error);
    });
  });
}

function kickstartMacDaemonLaunchAgent(options: { force?: boolean } = {}): Promise<boolean> {
  const target = macDaemonLaunchAgentTarget();
  if (!target) return Promise.resolve(false);

  const args = ["kickstart", ...(options.force ? ["-k"] : []), target];
  return new Promise((resolve) => {
    execFile("launchctl", args, { timeout: 5_000 }, (error) => {
      resolve(!error);
    });
  });
}

async function startMacDaemonLaunchAgentIfAvailable(options: { force?: boolean } = {}) {
  if (!(await macDaemonLaunchAgentIsInstalled())) {
    return null;
  }

  daemonProcess = null;
  setDaemonStatus("starting", {
    message: "Starting xMatrix daemon through the macOS LaunchAgent...",
  });

  const started = await kickstartMacDaemonLaunchAgent(options);
  return finishInstalledDaemonStartup(started,
    "xMatrix daemon LaunchAgent is installed, but macOS could not start it.",
    "xMatrix daemon LaunchAgent is starting; waiting for the daemon lock owner...",
  );
}

function startDaemonBestEffort() {
  if (process.env.XMATRIX_DESKTOP_DISABLE_DAEMON === "1" && !app.isPackaged) {
    // Dev-only: leave the installed app's daemon supervision alone entirely.
    return Promise.resolve(getDaemonStatus());
  }
  enableDaemonKeepAlive();
  clearDaemonRestartTimer();

  if (daemonStartInFlight) {
    return daemonStartInFlight;
  }

  daemonStartInFlight = startDaemonBestEffortInner().finally(() => {
    daemonStartInFlight = null;
  });
  return daemonStartInFlight;
}

async function startDaemonBestEffortInner() {
  if (isDaemonProcessAlive(daemonProcess)) {
    return getDaemonStatus();
  }

  if (daemonProcess) {
    daemonProcess = null;
  }

  setDaemonStatus("starting", { message: "Checking for an existing xMatrix daemon..." });

  const existing = await findExistingDaemonProcess();
  if (existing) {
    return runningLocalDaemonStatus(existing.pid, true);
  }

  const managedStatus = await startMacDaemonLaunchAgentIfAvailable();
  if (managedStatus) {
    return managedStatus;
  }

  const windowsManagedStatus = await startWindowsDaemonTaskIfAvailable();
  if (windowsManagedStatus) {
    return windowsManagedStatus;
  }

  const executable = resolveCliExecutable();
  if (!executable) {
    return setDaemonStatus("missing", {
      message: "xMatrix CLI was not found. Install the xMatrix CLI to run the local daemon.",
    });
  }
  setDaemonStatus("starting", { message: `Starting xMatrix daemon from ${executable}...` });
  try {
    daemonProcess = spawn(executable, ["daemon"], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: daemonEnvironment(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start xMatrix daemon.";
    setDaemonStatus("error", { message });
    scheduleDaemonRestart("Could not start xMatrix daemon; retrying...");
    return getDaemonStatus();
  }

  const child = daemonProcess;
  let daemonOutput = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    daemonOutput = rememberDaemonOutput(daemonOutput, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    daemonOutput = rememberDaemonOutput(daemonOutput, chunk);
  });
  rereadCliContextForNewDaemon(child.pid);
  setDaemonStatus(child.pid ? "running" : "starting", {
    pid: child.pid,
    message: child.pid
      ? `xMatrix daemon is running from ${executable}.`
      : `Starting xMatrix daemon from ${executable}.`,
  });

  child.on("error", (error: NodeJS.ErrnoException) => {
    const missing = error.code === "ENOENT";
    if (daemonProcess === child) {
      daemonProcess = null;
    }
    const message = missing
      ? "xmatrix CLI was not found on PATH."
      : daemonExitMessage(error.message || "Could not start xMatrix daemon.", daemonOutput);
    setDaemonStatus(missing ? "missing" : "error", {
      message,
    });
    if (!missing && !daemonFailureNeedsLogin(`${message} ${daemonOutput}`)) {
      scheduleDaemonRestart("xMatrix daemon start failed; retrying...");
    }
  });
  child.on("exit", (code, signal) => {
    if (daemonProcess === child) {
      daemonProcess = null;
    } else {
      return;
    }
    const message = signal
      ? `xMatrix daemon stopped by ${signal}.`
      : code === 0
        ? "xMatrix daemon stopped."
        : `xMatrix daemon exited with code ${code ?? "unknown"}.`;
    if (daemonFailureNeedsLogin(`${message} ${daemonOutput}`)) {
      setDaemonStatus("error", {
        message: daemonLoginRequiredMessage(daemonOutput),
      });
      return;
    }
    setDaemonStatus(code === 0 || signal ? "stopped" : "error", {
      message: daemonExitMessage(message, daemonOutput),
    });
    scheduleDaemonRestart(
      signal
        ? daemonExitMessage("xMatrix daemon stopped unexpectedly; restarting daemon...", daemonOutput)
        : code === 0
          ? daemonExitMessage("xMatrix daemon exited; checking heartbeat before restart...", daemonOutput)
          : daemonExitMessage("xMatrix daemon crashed; restarting daemon...", daemonOutput)
    );
  });

  return getDaemonStatus();
}

async function stopDaemon(options: { disableKeepAlive?: boolean } = {}) {
  if (options.disableKeepAlive !== false) {
    disableDaemonKeepAlive();
  } else {
    clearDaemonRestartTimer();
  }

  if (!daemonProcess || !isDaemonProcessAlive(daemonProcess)) {
    daemonProcess = null;
    const existing = await findExistingDaemonProcess();
    if (existing) {
      return setDaemonStatus("running", {
        pid: existing.pid,
        message: `xMatrix daemon is managed outside this app (pid ${existing.pid}).`,
      });
    }
    return setDaemonStatus("stopped", { message: "xMatrix daemon is stopped." });
  }

  const child = daemonProcess;
  daemonProcess = null;
  child.kill();
  return setDaemonStatus("stopped", { message: "xMatrix daemon stopped by desktop app." });
}

async function restartDaemon() {
  enableDaemonKeepAlive();
  clearDaemonRestartTimer();

  if (await windowsDaemonTaskIsInstalled()) {
    if (isDaemonProcessAlive(daemonProcess)) {
      daemonProcess.kill();
    }
    daemonProcess = null;

    const managedStatus = await startWindowsDaemonTaskIfAvailable({ force: true });
    if (managedStatus) {
      return managedStatus;
    }
  }

  if (await macDaemonLaunchAgentIsInstalled()) {
    if (isDaemonProcessAlive(daemonProcess)) {
      daemonProcess.kill();
    }
    daemonProcess = null;

    const managedStatus = await startMacDaemonLaunchAgentIfAvailable({ force: true });
    if (managedStatus) {
      return managedStatus;
    }
  }

  await stopDaemon({ disableKeepAlive: false });
  return startDaemonBestEffort();
}

function xmatrixConfigDir() {
  const configured = process.env.XMATRIX_CONFIG_DIR?.trim();
  if (configured) return configured;
  return path.join(app.getPath("home"), ".config", "xmatrix");
}

function desktopProfileSelectionPath() {
  return path.join(app.getPath("userData"), "local-profile-selection.json");
}

function explicitDesktopProfileId(): string | undefined {
  return desktopProfileSelection.mode === "explicit"
    ? desktopProfileSelection.profileId
    : undefined;
}

async function loadDesktopProfileSelection() {
  let explicitProfileId: string | undefined;
  try {
    const value = JSON.parse(fs.readFileSync(desktopProfileSelectionPath(), "utf8")) as {
      mode?: unknown;
      profileId?: unknown;
    };
    if (value.mode === "explicit" && typeof value.profileId === "string") {
      explicitProfileId = value.profileId;
    }
  } catch {
    // Missing or stale Desktop selection follows the installation default.
  }
  desktopProfileSelection = explicitProfileId
    ? { mode: "explicit", profileId: explicitProfileId }
    : { mode: "follow-default" };
  await refreshCliContext();
  // The CLI decides whether that profile still exists and is selectable.
  if (explicitProfileId && selectedCliContext?.profile?.id !== explicitProfileId) {
    desktopProfileSelection = { mode: "follow-default" };
    await refreshCliContext();
  }
}

async function persistDesktopProfileSelection() {
  await writePrivateJsonAtomic(desktopProfileSelectionPath(), desktopProfileSelection);
}

function selectedDesktopProfile(): DesktopCliProfile | null {
  return selectedCliContext?.profile ?? null;
}

async function publishDefaultProfileChanged(force = false) {
  await refreshCliContext();
  const profile = defaultCliContext?.profile;
  if (!profile || (!force && profile.revision <= lastDefaultProfileRevision)) return;
  if (profile.revision > lastDefaultProfileRevision) {
    lastDefaultProfileRevision = profile.revision;
  }
  broadcastToWindows("desktop:default-profile-changed", {
    revision: profile.revision,
    profileId: profile.id,
    name: profile.name,
    hubUrl: profile.hubUrl,
    followedByWindow: desktopProfileSelection.mode === "follow-default",
  });
}

function startProfileRegistryWatcher() {
  fs.mkdirSync(xmatrixConfigDir(), { recursive: true });
  profileRegistryWatcher?.close();
  profileRegistryWatcher = fs.watch(xmatrixConfigDir(), (_event, fileName) => {
    if (fileName?.toString() === "profiles.json") void publishDefaultProfileChanged();
  });
}

function setDesktopLocalProfileSelection(value: unknown) {
  const mutation = desktopProfileSelectionMutationTail.then(() =>
    applyDesktopLocalProfileSelection(value)
  );
  desktopProfileSelectionMutationTail = mutation.then(
    () => undefined,
    () => undefined,
  );
  return mutation;
}

async function applyDesktopLocalProfileSelection(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid local profile selection.");
  const input = value as { mode?: unknown; profileId?: unknown };
  if (input.mode === "follow-default") {
    desktopProfileSelection = { mode: "follow-default" };
    await refreshCliContext();
  } else if (input.mode === "explicit" && typeof input.profileId === "string") {
    const previous = desktopProfileSelection;
    desktopProfileSelection = { mode: "explicit", profileId: input.profileId };
    await refreshCliContext();
    const profile = selectedCliContext?.profile;
    if (!profile || profile.id !== input.profileId) {
      desktopProfileSelection = previous;
      await refreshCliContext();
      throw new Error("The explicit local profile is unavailable or invalid.");
    }
  } else {
    throw new Error("Invalid local profile selection.");
  }
  await persistDesktopProfileSelection();
  const profile = selectedDesktopProfile();
  const payload = { ...desktopProfileSelection, profile: profile || null };
  broadcastToWindows("desktop:local-profile-selection-changed", payload);
  return payload;
}

function desktopSettingsPath() {
  return path.join(xmatrixConfigDir(), "desktop.json");
}

function normalizeSetupStatus(value: unknown): DesktopSetupStatus {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const completedAt = typeof record.completedAt === "string" ? record.completedAt.trim() : "";
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt.trim() : "";
  const setupVersion = typeof record.setupVersion === "number" && Number.isFinite(record.setupVersion)
    ? Math.max(1, Math.floor(record.setupVersion))
    : DESKTOP_SETUP_VERSION;

  return {
    setupVersion,
    ...(completedAt ? { completedAt } : {}),
    updatedAt: updatedAt || new Date().toISOString(),
  };
}

async function getDesktopSetupStatus(): Promise<DesktopSetupStatus> {
  try {
    const raw = await fs.promises.readFile(desktopSettingsPath(), "utf8");
    return normalizeSetupStatus(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        setupVersion: DESKTOP_SETUP_VERSION,
        updatedAt: new Date().toISOString(),
      };
    }
    throw error;
  }
}

async function saveDesktopSetupStatus(value: unknown): Promise<DesktopSetupStatus> {
  const status = normalizeSetupStatus({
    ...(value && typeof value === "object" ? value as Record<string, unknown> : {}),
    setupVersion: DESKTOP_SETUP_VERSION,
    updatedAt: new Date().toISOString(),
  });
  const settingsPath = desktopSettingsPath();
  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.writeFile(settingsPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  if (process.platform !== "win32") {
    await fs.promises.chmod(settingsPath, 0o600).catch(() => undefined);
  }
  return status;
}

function normalizeWorkspacePathForStorage(value: string): string {
  const normalized = path.normalize(value);
  if (process.platform === "win32") {
    if (normalized.startsWith("\\\\?\\UNC\\")) return `\\\\${normalized.slice(8)}`;
    if (normalized.startsWith("\\\\?\\")) return normalized.slice(4);
  }
  return normalized;
}

function workspaceDisplayName(workspacePath: string): string {
  return path.basename(workspacePath) || workspacePath;
}

function execFileText(
  executable: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<string> {
  const useShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
  return new Promise((resolve) => {
    try {
      execFile(
        executable,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeout ?? 3_000,
          env: {
            ...process.env,
            PATH: augmentPath(process.env.PATH),
          },
          shell: useShell,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve("");
            return;
          }
          resolve((stdout || stderr).trim());
        }
      );
    } catch {
      resolve("");
    }
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  const output = await execFileText("git", args, { cwd, timeout: 2_000 });
  return output || undefined;
}

async function workspaceCandidateFromPath(workspacePath: string): Promise<DesktopWorkspaceCandidate> {
  const trimmed = workspacePath.trim();
  if (!trimmed) throw new Error("Workspace path is required");
  if (!path.isAbsolute(trimmed)) throw new Error("Workspace path must be absolute");

  const canonicalPath = await fs.promises.realpath(trimmed);
  const stat = await fs.promises.stat(canonicalPath);
  if (!stat.isDirectory()) {
    throw new Error("Workspace path is not a directory");
  }

  const machineId = cliMachineId();
  const hostname = os.hostname();
  const [repoRoot, gitRemote, gitBranch] = await Promise.all([
    gitOutput(canonicalPath, ["rev-parse", "--show-toplevel"]),
    gitOutput(canonicalPath, ["remote", "get-url", "origin"]),
    gitOutput(canonicalPath, ["branch", "--show-current"]),
  ]);

  return {
    path: canonicalPath,
    canonicalCwd: normalizeWorkspacePathForStorage(canonicalPath),
    displayName: workspaceDisplayName(canonicalPath),
    machineId,
    hostname,
    repoRoot,
    gitRemote,
    gitBranch,
  };
}

function expandHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function decodeClaudeProjectDirName(name: string): string | null {
  const trimmed = name.replace(/^-+|-+$/g, "");
  if (!trimmed) return null;
  const decoded = path.sep + trimmed.replace(/-/g, path.sep);
  return path.isAbsolute(decoded) ? decoded : null;
}

function collectWorkspacePathsFromJson(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectWorkspacePathsFromJson(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      ["cwd", "currentdir", "current_dir", "canonicalcwd", "canonical_cwd", "workspaceroot", "workspace_root", "workspace"]
        .includes(lower) &&
      typeof item === "string" &&
      path.isAbsolute(item)
    ) {
      output.add(item);
    }
    collectWorkspacePathsFromJson(item, output);
  }
}

async function scanJsonWorkspaceFile(filePath: string, output: Set<string>): Promise<void> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || stat.size > 2_000_000) return;
  const raw = await fs.promises.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return;
  const isJsonl = filePath.endsWith(".jsonl");
  for (const line of raw.split(/\r?\n/).slice(0, 2_000)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      collectWorkspacePathsFromJson(JSON.parse(trimmed), output);
    } catch {
      // Ignore non-JSON lines in mixed history files.
    }
  }
  if (!isJsonl) {
    try {
      collectWorkspacePathsFromJson(JSON.parse(raw), output);
    } catch {
      // Ignore malformed config files.
    }
  }
}

async function scanClassicWorkspacePaths(root: string): Promise<string[]> {
  const output = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > 5 || visited > 1_500) continue;
    visited += 1;
    const entries = await fs.promises.readdir(current.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (path.basename(path.dirname(entryPath)) === "projects") {
          const decoded = decodeClaudeProjectDirName(entry.name);
          if (decoded) output.add(decoded);
        }
        stack.push({ dir: entryPath, depth: current.depth + 1 });
      } else if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))) {
        await scanJsonWorkspaceFile(entryPath, output);
      }
    }
  }

  const valid: string[] = [];
  for (const candidate of output) {
    const stat = await fs.promises.stat(candidate).catch(() => null);
    if (stat?.isDirectory()) valid.push(candidate);
  }
  return Array.from(new Set(valid)).sort((left, right) => left.localeCompare(right));
}

async function discoverAgentPresets(presets: DesktopAgentPresetInput[]): Promise<DesktopAgentPresetDiscovery[]> {
  const knownPresets = Array.isArray(presets) ? presets.filter((preset) => preset.id !== "custom") : [];
  const discoveries: DesktopAgentPresetDiscovery[] = [];
  for (const preset of knownPresets) {
    const configDirs: string[] = [];
    for (const dir of preset.classicConfigDirs || []) {
      const expanded = expandHomePath(dir);
      const stat = await fs.promises.stat(expanded).catch(() => null);
      if (stat?.isDirectory()) configDirs.push(expanded);
    }
    const workspacePaths = Array.from(new Set((await Promise.all(configDirs.map(scanClassicWorkspacePaths))).flat()));
    const workspaces: DesktopWorkspaceCandidate[] = [];
    for (const workspacePath of workspacePaths) {
      try {
        workspaces.push(await workspaceCandidateFromPath(workspacePath));
      } catch {
        // Ignore paths that disappeared or fail git/path inspection.
      }
    }
    const runtimeAvailable =
      Boolean(await execFileText(preset.runtime, ["--version"], { timeout: 3_000 })) ||
      Boolean(await firstAvailableLauncher(preset.launcherNames || []));
    discoveries.push({
      presetId: preset.id,
      displayName: preset.displayName,
      runtime: preset.runtime,
      backend: preset.backend,
      runtimeAvailable,
      configDirs,
      workspaces,
    });
  }
  return discoveries;
}

async function firstAvailableLauncher(launcherNames: string[]): Promise<string | undefined> {
  for (const launcher of launcherNames) {
    if (!launcher.trim()) continue;
    const result = await execFileText(launcher, ["--version"], {
      timeout: 3_000,
    });
    if (result) return launcher;
  }
  return undefined;
}

async function chooseWorkspaceDirectory(): Promise<DesktopWorkspaceCandidate | null> {
  const parentWindow = primaryWindow();
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, {
        properties: ["openDirectory", "createDirectory"],
        title: "Add xMatrix workspace",
      })
    : await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "Add xMatrix workspace",
      });
  if (result.canceled || !result.filePaths[0]) return null;
  return workspaceCandidateFromPath(result.filePaths[0]);
}

async function validateWorkspacePath(value: string): Promise<DesktopPathValidationResult> {
  try {
    const candidate = await workspaceCandidateFromPath(value);
    return {
      ok: true,
      path: candidate.path,
      canonicalCwd: candidate.canonicalCwd,
      displayName: candidate.displayName,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Workspace path is invalid",
    };
  }
}

async function revealWorkspacePath(value: string): Promise<boolean> {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || !path.isAbsolute(trimmed)) return false;
  const error = await shell.openPath(trimmed);
  return !error;
}

async function checkRuntime(runtime: string): Promise<DesktopRuntimeCheckResult> {
  const executable = typeof runtime === "string" ? runtime.trim() : "";
  if (!executable) return { ok: false, runtime: executable, error: "Runtime is required" };
  if (executable.startsWith("-")) {
    return { ok: false, runtime: executable, error: "Runtime cannot start with a flag" };
  }

  return new Promise((resolve) => {
    execFile(
      executable,
      ["--version"],
      {
        timeout: 3_000,
        env: {
          ...process.env,
          PATH: augmentPath(process.env.PATH),
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            runtime: executable,
            error: error.message || "Runtime was not found",
          });
          return;
        }
        resolve({
          ok: true,
          runtime: executable,
          path: executable,
          version: (stdout || stderr).trim() || undefined,
        });
      }
    );
  });
}

function registerIpcHandlers() {
  ipcMain.handle("desktop:get-context", secureIpc(() => {
    return {
      client: "desktop",
      platform: process.platform,
      machineId: cliMachineId(),
      hostname: os.hostname(),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      startUrl: getStartUrl(),
    };
  }));
  ipcMain.handle("desktop:get-full-screen", secureIpc((event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
  }));
  ipcMain.handle("desktop:get-local-profile", secureIpc(() => ({
    ...desktopProfileSelection,
    profile: selectedDesktopProfile() || null,
  })));
  ipcMain.handle("desktop:set-local-profile", secureIpc((_event, selection: unknown) =>
    setDesktopLocalProfileSelection(selection)
  ));

  ipcMain.handle("desktop:set-badge", secureIpc((event, state: DesktopBadgeState) => {
    const window = senderWindow(event);
    if (!window) return;
    windowBadges.set(window.id, {
      mentionCount: state?.mentionCount ?? 0,
      hasUnread: Boolean(state?.hasUnread),
    });
    refreshDockBadge();
  }));

  ipcMain.handle("desktop:set-title", secureIpc((event, title: string) => {
    if (typeof title === "string" && title.trim()) {
      // Per window: each window titles itself after the Space it is showing.
      senderWindow(event)?.setTitle(title.trim());
    }
  }));

  /**
   * Open an in-app route in its own window — how the web Space switcher offers
   * "Open in New Window". The renderer names a path, never an origin; anything
   * that could leave the app origin is refused rather than normalized.
   */
  ipcMain.handle("desktop:open-window", secureIpc((_event, requestedPath?: string) => {
    if (typeof requestedPath !== "string" || !requestedPath.trim()) {
      createWindow();
      return true;
    }
    const target = resolveInternalAppUrl(getStartUrl(), requestedPath);
    if (!target) return false;
    openWindowForUrl(target, { navigateExisting: false });
    return true;
  }));

  ipcMain.handle("desktop:get-notification-settings", secureIpc(() => getNotificationSettings()));
  ipcMain.handle("desktop:request-notifications", secureIpc(() => getNotificationSettings()));

  ipcMain.handle("desktop:notify", secureIpc((event, payload: DesktopNotificationPayload) => {
    return showNativeNotification(payload || {}, senderWindow(event)?.id);
  }));

  ipcMain.handle(
    "desktop:write-clipboard-image",
    secureIpc(
      (
        _event,
        image: {
          name?: string;
          mimeType: string;
          size: number;
          dataUrl: string;
        },
      ) => {
        if (!image?.dataUrl || typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:")) {
          throw new Error("Invalid clipboard image data URL");
        }
        // Bound payload size (~12 MiB base64) so a bad caller cannot pin the main process.
        if (image.dataUrl.length > 16 * 1024 * 1024) {
          throw new Error("Clipboard image payload is too large");
        }
        const native = nativeImage.createFromDataURL(image.dataUrl);
        if (native.isEmpty()) {
          throw new Error("Could not decode clipboard image");
        }
        clipboard.writeImage(native);
      },
    ),
  );

  ipcMain.handle("desktop:open-external", secureIpc((_event, url: string) => {
    if (typeof url === "string") {
      openExternalUrl(url);
    }
  }));

  ipcMain.handle("desktop:check-cli-installed", secureIpc(() => checkCliInstalled()));

  ipcMain.handle("desktop:save-cli-session", secureIpc((_event, payload: DesktopCliSessionPayload) =>
    saveCliSession(payload)
  ));

  ipcMain.handle("desktop:refresh-cli-session", secureIpc((_event, payload: DesktopCliSessionPayload) =>
    refreshCliSession(payload)
  ));

  ipcMain.handle("desktop:open-cli-install", secureIpc(() => {
    openExternalUrl(CLI_INSTALL_URL);
  }));
  ipcMain.handle("desktop:install-cli", secureIpc(() => installCliFromDesktopSeed()));

  ipcMain.handle("desktop:get-daemon-status", secureIpc(() => getDaemonStatus()));
  ipcMain.handle("desktop:start-daemon", secureIpc(() => startDaemonBestEffort()));
  ipcMain.handle("desktop:stop-daemon", secureIpc(() => stopDaemon()));
  ipcMain.handle("desktop:restart-daemon", secureIpc(() => restartDaemon()));
  ipcMain.handle("desktop:switch-environment", secureIpc((_event, environment: unknown) =>
    switchClientEnvironment(environment)
  ));
  ipcMain.handle("desktop:get-setup-status", secureIpc(() => getDesktopSetupStatus()));
  ipcMain.handle("desktop:save-setup-status", secureIpc((_event, status: DesktopSetupStatus) =>
    saveDesktopSetupStatus(status)
  ));
  ipcMain.handle("desktop:choose-workspace-directory", secureIpc(() => chooseWorkspaceDirectory()));
  ipcMain.handle("desktop:validate-workspace-path", secureIpc((_event, workspacePath: string) =>
    validateWorkspacePath(workspacePath)
  ));
  ipcMain.handle("desktop:discover-agent-presets", secureIpc((_event, presets: DesktopAgentPresetInput[]) =>
    discoverAgentPresets(presets)
  ));
  ipcMain.handle("desktop:install-agent-preset", secureIpc((_event, presetId: unknown) =>
    installAgentPreset(presetId, { ...process.env, PATH: augmentPath(process.env.PATH) })
  ));
  ipcMain.handle("desktop:reveal-path", secureIpc((_event, workspacePath: string) =>
    revealWorkspacePath(workspacePath)
  ));
  ipcMain.handle("desktop:check-runtime", secureIpc((_event, runtime: string) => checkRuntime(runtime)));

  ipcMain.handle("desktop:check-for-updates", secureIpc(() => checkForUpdates(true)));
  ipcMain.handle("desktop:get-update-status", secureIpc(() => getUpdateStatus()));
  ipcMain.handle("desktop:install-update", secureIpc(() => installDownloadedUpdate()));
  ipcMain.handle("desktop:show-update-notification", secureIpc((_event, payload?: DesktopNotificationPayload) =>
    showUpdateNotification(payload)
  ));
}

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(APP_PROTOCOL);
}

app.on("second-instance", (_event, argv) => {
  const link = argv.find((value) => value.startsWith(`${APP_PROTOCOL}:`));
  if (link) {
    openDeepLink(link);
    return;
  }

  // Relaunching the app with every window closed must give the user a window
  // back; otherwise just raise the one they were last in.
  const window = primaryWindow();
  if (window) {
    revealWindow(window);
  } else {
    createWindow();
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (liveWindows().length > 0) {
    openDeepLink(url);
  } else {
    pendingDeepLink = url;
  }
});

function dropStaleRendererConnections() {
  // Mac sleep leaves Chromium holding dead HTTP/2 sockets. The next send then
  // hangs until the 15s deadline and the catalog fetch reports Failed to fetch.
  // Windows share one session, but closing it once per window is harmless and
  // keeps this correct if a window is ever given its own partition.
  for (const window of liveWindows()) {
    const contents = window.webContents;
    if (!contents.isDestroyed()) contents.session.closeAllConnections();
  }
}

app.whenReady().then(async () => {
  applyDesktopNativeTheme();
  desktopProfileReady = loadDesktopProfileSelection();
  registerIpcHandlers();
  createWindow();
  await desktopProfileReady;
  if (appIsQuitting) return;
  startProfileRegistryWatcher();
  buildMenu();
  void startDaemonBestEffort();
  configureAutoUpdates();
  powerMonitor.on("resume", dropStaleRendererConnections);
  powerMonitor.on("unlock-screen", dropStaleRendererConnections);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  appIsQuitting = true;
  disableDaemonKeepAlive();
  stopDaemonHeartbeat();
  profileRegistryWatcher?.close();
  profileRegistryWatcher = null;
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill();
    daemonProcess = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
